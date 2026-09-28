//! Removes console repaints from a pseudo-terminal's byte stream.
//!
//! # The problem this exists for
//!
//! A ConPTY session's console starts on the system OEM code page — 936 on a
//! Chinese Windows — and UTF-8 output written through the console API is
//! re-read as GBK unless it is switched. `pty.rs` therefore primes the console
//! to UTF-8 before the real program starts.
//!
//! Changing the code page makes conhost erase and rewrite its entire screen
//! buffer, and every rewritten row arrives at the reader as a bare `ESC[K` plus
//! a line ending. In a 24-row window that is two dozen empty lines scrolled into
//! the user's terminal before the first byte of actual output — which is exactly
//! what users reported as "output that is not clean".
//!
//! Measured on a real machine (see `.workbuddy/pty-probe/src/bin/blank.rs`):
//! priming with `cmd /c chcp`, priming with `chcp.com` directly, priming through
//! a one-row console and then resizing, and priming and then draining the pipe's
//! backlog all produce 23–24 blank lines. The repaint is inherent to the change
//! and cannot be avoided by arranging the spawn differently — so it is removed
//! from the stream here instead.
//!
//! # Why a run, and not every token
//!
//! ConPTY appends a *single* `ESC[K\r\n` to every row it renders, so one on its
//! own is ordinary output — it is what the end of a program's line looks like,
//! and dropping it would join two lines together. Only a run of them means
//! conhost redrew the whole buffer, which no program does by accident. See
//! [`SWEEP_MIN_RUN`].
//!
//! # Where it runs
//!
//! In the output pump, before the bytes are batched, so the same clean stream
//! reaches both the terminal and the run's log file. A log padded with two dozen
//! empty lines would be no easier to read than the terminal was.
//!
//! This module deliberately has no dependencies outside `std`: the probe that
//! measured the repaint includes this very file (`#[path = …]`) so that what it
//! tests is the shipped algorithm rather than a copy of it.

/// The byte sequences a repainted row is made of.
///
/// Both line endings, because a program can put the console in either mode and
/// the repaint is emitted by conhost, not by the program.
pub const SWEEP_TOKENS: [&[u8]; 2] = [b"\x1b[K\r\n", b"\x1b[K\n"];

/// How many such tokens in a row mean "the screen was repainted" rather than
/// "a line of output ended".
///
/// Two, because one is what every rendered line ends with. A genuine pair of
/// consecutive blank lines — an editor file with a blank line, say — reaches the
/// console as plain `\r\n\r\n` with no `ESC[K` between them, so it is not
/// affected.
pub const SWEEP_MIN_RUN: usize = 2;

/// Removes those repaints from the byte stream on its way to the frontend and to
/// the run log.
///
/// Stateful and chunk-tolerant on purpose: the pump forwards whatever a single
/// `read` returned, so a repaint can straddle two chunks. Bytes that might yet
/// begin a token are held back until the next chunk decides — the hold is at
/// most one token's worth (5 bytes).
#[derive(Default)]
pub struct BlankSweep {
    /// Complete tokens seen so far and not yet forwarded.
    run: Vec<u8>,
    /// How many tokens `run` holds.
    count: usize,
    /// A trailing fragment that may or may not complete into a token.
    tail: Vec<u8>,
}

impl BlankSweep {
    /// Filter one chunk, returning what should be forwarded.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        // A token split across the previous boundary is completed here, which is
        // what keeps a run that straddles two chunks from being missed.
        let mut work = std::mem::take(&mut self.tail);
        work.extend_from_slice(chunk);

        let mut out = Vec::with_capacity(work.len());
        let mut i = 0;
        while i < work.len() {
            let rest = &work[i..];
            if let Some(len) = SWEEP_TOKENS
                .iter()
                .find_map(|t| rest.starts_with(t).then_some(t.len()))
            {
                self.run.extend_from_slice(&rest[..len]);
                self.count += 1;
                i += len;
                continue;
            }
            if SWEEP_TOKENS
                .iter()
                .any(|t| rest.len() < t.len() && t.starts_with(rest))
            {
                // The chunk ran out inside a token, so whether it joins a run is
                // not decidable yet.
                self.tail.extend_from_slice(rest);
                break;
            }
            // Anything that cannot extend a run ends it.
            self.flush_run(&mut out);
            // Copy forward to the next ESC: no ordinary byte can start a token,
            // and ESC is the only byte that can, so this jumps whole spans at a
            // time instead of testing every byte.
            match rest.iter().position(|b| *b == 0x1b) {
                Some(0) => {
                    out.push(rest[0]);
                    i += 1;
                }
                Some(off) => {
                    out.extend_from_slice(&rest[..off]);
                    i += off;
                }
                None => {
                    out.extend_from_slice(rest);
                    i = work.len();
                }
            }
        }
        out
    }

    /// Flush what is left when the stream ends. A lone held token is output, not
    /// a repaint, so it is kept.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        self.flush_run(&mut out);
        out.extend_from_slice(&self.tail);
        self.tail.clear();
        out
    }

    /// Decide on the held tokens: a run is dropped, a single one is output.
    fn flush_run(&mut self, out: &mut Vec<u8>) {
        if self.count < SWEEP_MIN_RUN {
            out.extend_from_slice(&self.run);
        }
        self.run.clear();
        self.count = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed every part in order, then finish, as the pump would.
    fn swept(parts: &[&[u8]]) -> Vec<u8> {
        let mut sweep = BlankSweep::default();
        let mut out = Vec::new();
        for part in parts {
            out.extend(sweep.feed(part));
        }
        out.extend(sweep.finish());
        out
    }

    /// A repaint is exactly what conhost sends when the code page changes: the
    /// measured stream was 23 of these in a row.
    fn repaint(count: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for _ in 0..count {
            out.extend_from_slice(b"\x1b[K\r\n");
        }
        out
    }

    #[test]
    fn a_single_erase_token_is_kept() {
        // This is what ConPTY appends to every line it renders, so it must
        // survive — dropping it would join two lines of output together.
        let line = b"first-line\x1b[K\r\n";
        assert_eq!(swept(&[line]), line.to_vec());
    }

    #[test]
    fn a_lone_token_at_the_end_of_a_stream_is_kept() {
        assert_eq!(swept(&[b"end\x1b[K\r\n"]), b"end\x1b[K\r\n".to_vec());
        // The trailing `ESC[K` of a repaint is not followed by a newline, so it
        // is not a token either.
        assert_eq!(swept(&[b"end\x1b[K"]), b"end\x1b[K".to_vec());
    }

    #[test]
    fn a_run_is_dropped_and_the_output_around_it_kept() {
        let mut input = b"head".to_vec();
        input.extend_from_slice(&repaint(23));
        input.extend_from_slice(b"first-line\r\nsecond-line\r\n");
        assert_eq!(
            swept(&[&input]),
            b"headfirst-line\r\nsecond-line\r\n".to_vec()
        );
    }

    #[test]
    fn a_run_split_across_chunks_is_still_dropped() {
        // The chunk boundary lands inside both the first token and the run.
        let out = swept(&[b"head\x1b[K\r", b"\n\x1b[K\r\n\x1b[K\r\n\x1b[K\r\ntail"]);
        assert_eq!(out, b"headtail".to_vec());
    }

    #[test]
    fn a_two_token_run_is_dropped() {
        // Two is the threshold: below it is output, at it is a repaint.
        assert_eq!(swept(&[b"a\x1b[K\n\x1b[K\nb"]), b"ab".to_vec());
    }

    #[test]
    fn a_run_that_was_actually_two_separate_tokens_is_kept() {
        // The same bytes, but a byte that cannot extend a run sits between them,
        // which is what tells the two apart.
        let out = swept(&[b"a\x1b[K\r\nX\x1b[K\r\nb"]);
        assert_eq!(out, b"a\x1b[K\r\nX\x1b[K\r\nb".to_vec());
    }

    #[test]
    fn a_partial_token_after_a_run_survives() {
        // What D1's measured stream ends with: 23 tokens then a bare `ESC[K`.
        let mut input = repaint(23);
        input.extend_from_slice(b"\x1b[K\x1b[H\x1b[?25h");
        assert_eq!(swept(&[&input]), b"\x1b[K\x1b[H\x1b[?25h".to_vec());
    }

    #[test]
    fn nothing_is_held_back_once_a_run_ends() {
        // Only the tail may be held; everything before it is out immediately.
        let mut sweep = BlankSweep::default();
        assert_eq!(sweep.feed(b"plain output\r\n"), b"plain output\r\n".to_vec());
    }

    #[test]
    fn real_output_is_never_touched() {
        // The shape of an actual `dir` listing, CRLF and all, with no repaint in
        // it: byte-for-byte identical on the way through.
        let listing = b" Volume in drive D has no label.\r\n\r\n Directory of D:\\x\r\n\r\n09/28/2026  01:02 PM                12 a.php\r\n";
        assert_eq!(swept(&[listing]), listing.to_vec());
    }
}

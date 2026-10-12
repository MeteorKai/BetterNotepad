use std::time::Duration;

async fn probe_endpoint(endpoint: &str) -> Result<u16, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("BetterNotepad-update-diagnostics");
    #[cfg(test)]
    let builder = builder.no_proxy();
    let client = builder.build().map_err(|error| error.to_string())?;
    client
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .await
        .map(|response| response.status().as_u16())
        .map_err(|error| {
            if error.is_timeout() {
                format!("Update endpoint request timed out: {error}")
            } else {
                // Include the cause chain, which can identify DNS/TLS failures.
                let mut details = error.to_string();
                let mut cause = std::error::Error::source(&error);
                while let Some(error) = cause {
                    details.push_str(&format!(": {error}"));
                    cause = error.source();
                }
                details
            }
        })
}

/// Only query the configured updater endpoint, never a frontend-supplied URL.
#[tauri::command]
pub async fn update_endpoint_status(app: tauri::AppHandle) -> Result<u16, String> {
    let endpoint = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.get(0))
        .and_then(serde_json::Value::as_str)
        .filter(|endpoint| endpoint.starts_with("https://"))
        .ok_or_else(|| "Updater does not have secure protocol endpoints set.".to_string())?;
    probe_endpoint(endpoint).await
}

#[cfg(test)]
mod tests {
    use super::probe_endpoint;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    #[test]
    fn reports_actual_http_status_instead_of_losing_non_success_responses() {
        for status in [200, 403, 404, 429, 503] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}/latest.json", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(3);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "HTTP probe never connected");
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 4096];
                let size = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..size]).starts_with("GET /latest.json "));
                write!(
                    stream,
                    "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            });
            let result = tauri::async_runtime::block_on(probe_endpoint(&url));
            server.join().unwrap();
            assert_eq!(result.unwrap(), status);
        }
    }

    #[test]
    fn connection_failure_keeps_the_underlying_cause() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/latest.json", listener.local_addr().unwrap());
        drop(listener);
        let error = tauri::async_runtime::block_on(probe_endpoint(&url)).unwrap_err();
        assert!(error.contains("error sending request"), "{error}");
        assert!(
            error.contains("connect") || error.contains("连接"),
            "{error}"
        );
    }
}

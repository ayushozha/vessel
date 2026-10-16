//! Minimal HTTP/1.1 JSON server for wasm32-wasip1(-threads) running on Wasmer.
//! Rust's wasip1 std cannot bind sockets, so we open/bind/listen/accept via
//! Wasmer's WASIX syscalls (the official `wasix` crate) and then treat the
//! connection fds as ordinary files.
use std::fs::File;
use std::io::{Read, Write};
use std::os::wasi::io::FromRawFd;
use wasix::{AddrIp4, AddrIp4Port, AddrPort, AddrPortU};

fn listen(port: u16) -> Result<u32, wasix::Errno> {
    unsafe {
        let fd = wasix::sock_open(wasix::ADDRESS_FAMILY_INET4, wasix::SOCK_TYPE_SOCKET_STREAM, wasix::SOCK_PROTO_TCP)?;
        // Loopback only: in network host mode the guest's bind is a real host listener,
        // and 0.0.0.0 would expose it on every host interface.
        let loopback = AddrIp4 { n0: 127, n1: 0, h0: 0, h1: 1 };
        let addr = AddrPort {
            tag: wasix::ADDRESS_FAMILY_INET4.raw(),
            u: AddrPortU { inet4: AddrIp4Port { port, addr: loopback } }, // port in host byte order
        };
        wasix::sock_bind(fd, &addr)?;
        wasix::sock_listen(fd, 128)?;
        Ok(fd)
    }
}

fn handle(conn: u32, hits: u64) {
    let mut stream = unsafe { File::from_raw_fd(conn as i32) };
    let mut buf = [0u8; 2048];
    let _ = stream.read(&mut buf);
    let body = format!(r#"{{"lang":"rust","runtime":"wasix","hits":{hits}}}"#);
    let res = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(res.as_bytes());
}

fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let fd = listen(port).expect("listen");
    println!("listening on {port}");
    for hits in 1u64.. {
        match unsafe { wasix::sock_accept_v2(fd, 0) } {
            // A thread per connection keeps one slow client from stalling the rest.
            Ok((conn, _)) => drop(std::thread::spawn(move || handle(conn, hits))),
            Err(e) => eprintln!("accept: {e}"),
        }
    }
}

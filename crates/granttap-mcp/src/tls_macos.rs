//! Minimal macOS client TLS via Secure Transport (no crates.io TLS stack).
//!
//! This keeps GrantTap's `wss://` path on a single signed binary that can later
//! be allow-listed for Accessibility / LaunchAgent without depending on Node.

#![cfg(target_os = "macos")]
#![allow(unsafe_code)]

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::ptr;

type OSStatus = i32;
type SSLContextRef = *mut std::ffi::c_void;
type SSLConnectionRef = *const std::ffi::c_void;

const ERR_SSL_WOULD_BLOCK: OSStatus = -98_033;
const ERR_SSL_CLOSED_GRACEFUL: OSStatus = -98_035;
const NO_ERR: OSStatus = 0;

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SSLCreateContext(
        alloc: *const std::ffi::c_void,
        protocol_side: i32,
        connection_type: i32,
    ) -> SSLContextRef;
    fn SSLDisposeContext(context: SSLContextRef);
    fn SSLSetConnection(context: SSLContextRef, connection: SSLConnectionRef) -> OSStatus;
    fn SSLSetIOFuncs(
        context: SSLContextRef,
        read_func: unsafe extern "C" fn(
            SSLConnectionRef,
            *mut u8,
            *mut usize,
        ) -> OSStatus,
        write_func: unsafe extern "C" fn(
            SSLConnectionRef,
            *const u8,
            *mut usize,
        ) -> OSStatus,
    ) -> OSStatus;
    fn SSLSetPeerDomainName(
        context: SSLContextRef,
        peer_name: *const i8,
        peer_name_len: usize,
    ) -> OSStatus;
    fn SSLHandshake(context: SSLContextRef) -> OSStatus;
    fn SSLWrite(
        context: SSLContextRef,
        data: *const u8,
        data_len: usize,
        processed: *mut usize,
    ) -> OSStatus;
    fn SSLRead(
        context: SSLContextRef,
        data: *mut u8,
        data_len: usize,
        processed: *mut usize,
    ) -> OSStatus;
    fn SSLClose(context: SSLContextRef) -> OSStatus;
}

const K_SSL_CLIENT_SIDE: i32 = 0;
const K_SSL_STREAM_TYPE: i32 = 0;

struct ConnState {
    stream: TcpStream,
}

pub struct TlsStream {
    ctx: SSLContextRef,
    // Kept alive for the C callbacks; boxed so the address is stable.
    conn: *mut ConnState,
}

unsafe impl Send for TlsStream {}

impl TlsStream {
    pub fn connect(stream: TcpStream, hostname: &str) -> io::Result<Self> {
        let conn = Box::into_raw(Box::new(ConnState { stream }));
        unsafe {
            let ctx = SSLCreateContext(ptr::null(), K_SSL_CLIENT_SIDE, K_SSL_STREAM_TYPE);
            if ctx.is_null() {
                let _ = Box::from_raw(conn);
                return Err(io::Error::other("SSLCreateContext failed"));
            }
            let status = SSLSetIOFuncs(ctx, ssl_read, ssl_write);
            if status != NO_ERR {
                SSLDisposeContext(ctx);
                let _ = Box::from_raw(conn);
                return Err(io::Error::other(format!("SSLSetIOFuncs {status}")));
            }
            let status = SSLSetConnection(ctx, conn.cast());
            if status != NO_ERR {
                SSLDisposeContext(ctx);
                let _ = Box::from_raw(conn);
                return Err(io::Error::other(format!("SSLSetConnection {status}")));
            }
            let c_host = std::ffi::CString::new(hostname)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
            let status =
                SSLSetPeerDomainName(ctx, c_host.as_ptr(), hostname.len());
            if status != NO_ERR {
                SSLDisposeContext(ctx);
                let _ = Box::from_raw(conn);
                return Err(io::Error::other(format!("SSLSetPeerDomainName {status}")));
            }
            loop {
                let status = SSLHandshake(ctx);
                if status == NO_ERR {
                    break;
                }
                if status != ERR_SSL_WOULD_BLOCK {
                    SSLDisposeContext(ctx);
                    let _ = Box::from_raw(conn);
                    return Err(io::Error::other(format!("SSLHandshake {status}")));
                }
            }
            Ok(Self { ctx, conn })
        }
    }
}

impl Drop for TlsStream {
    fn drop(&mut self) {
        unsafe {
            let _ = SSLClose(self.ctx);
            SSLDisposeContext(self.ctx);
            let _ = Box::from_raw(self.conn);
        }
    }
}

impl Read for TlsStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut processed = 0_usize;
        let status = unsafe { SSLRead(self.ctx, buf.as_mut_ptr(), buf.len(), &mut processed) };
        if status == NO_ERR || (status == ERR_SSL_WOULD_BLOCK && processed > 0) {
            return Ok(processed);
        }
        if status == ERR_SSL_CLOSED_GRACEFUL {
            return Ok(0);
        }
        if status == ERR_SSL_WOULD_BLOCK {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "ssl would block",
            ));
        }
        Err(io::Error::other(format!("SSLRead {status}")))
    }
}

impl Write for TlsStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut processed = 0_usize;
        let status = unsafe { SSLWrite(self.ctx, buf.as_ptr(), buf.len(), &mut processed) };
        if status == NO_ERR || (status == ERR_SSL_WOULD_BLOCK && processed > 0) {
            return Ok(processed);
        }
        if status == ERR_SSL_WOULD_BLOCK {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "ssl would block",
            ));
        }
        Err(io::Error::other(format!("SSLWrite {status}")))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

unsafe extern "C" fn ssl_read(
    connection: SSLConnectionRef,
    data: *mut u8,
    data_len: *mut usize,
) -> OSStatus {
    let want = *data_len;
    let buf = std::slice::from_raw_parts_mut(data, want);
    // Safety: exclusive ownership via TlsStream.
    let stream_mut = &mut *(connection.cast_mut() as *mut ConnState);
    match stream_mut.stream.read(buf) {
        Ok(0) => {
            *data_len = 0;
            ERR_SSL_CLOSED_GRACEFUL
        }
        Ok(n) => {
            *data_len = n;
            NO_ERR
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
            *data_len = 0;
            ERR_SSL_WOULD_BLOCK
        }
        Err(_) => {
            *data_len = 0;
            -1
        }
    }
}

unsafe extern "C" fn ssl_write(
    connection: SSLConnectionRef,
    data: *const u8,
    data_len: *mut usize,
) -> OSStatus {
    let stream_mut = &mut *(connection.cast_mut() as *mut ConnState);
    let want = *data_len;
    let buf = std::slice::from_raw_parts(data, want);
    match stream_mut.stream.write(buf) {
        Ok(n) => {
            *data_len = n;
            NO_ERR
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
            *data_len = 0;
            ERR_SSL_WOULD_BLOCK
        }
        Err(_) => {
            *data_len = 0;
            -1
        }
    }
}

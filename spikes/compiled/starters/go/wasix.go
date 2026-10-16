//go:build wasip1

package main

import (
	"fmt"
	"net"
	"os"
	"syscall"
	"unsafe"
)

// Stock GOOS=wasip1 cannot open server sockets, but Wasmer implements the
// WASIX socket syscalls. net.FileListener rejects these fds because Wasmer
// reports their filetype as unknown, so we wrap them ourselves: fds are
// non-blocking and Go's poller (poll_oneoff) waits for readiness, so
// goroutines and net/http work normally.

//go:wasmimport wasix_32v1 sock_open
func sockOpen(af, socktype, proto uint32, fd unsafe.Pointer) uint32

//go:wasmimport wasix_32v1 sock_bind
func sockBind(fd uint32, addr unsafe.Pointer) uint32

//go:wasmimport wasix_32v1 sock_listen
func sockListen(fd, backlog uint32) uint32

//go:wasmimport wasix_32v1 sock_accept_v2
func sockAcceptV2(fd, flags uint32, newFd, addr unsafe.Pointer) uint32

//go:wasmimport wasi_snapshot_preview1 fd_fdstat_set_flags
func fdFdstatSetFlags(fd, flags uint32) uint32

// addrPort mirrors WASIX __wasi_addr_port_t for IPv4: tag u8, pad u8,
// port u16 (host order), 4 address bytes, then padding to the union size.
type addrPort struct {
	tag  uint8
	_    uint8
	port uint16
	ip   [4]byte
	_    [32]byte
}

const (
	afInet4    = 1
	sockStream = 1
	protoTCP   = 6
	fdNonblock = 4 // __WASI_FDFLAGS_NONBLOCK
	errnoAgain = 6 // __WASI_ERRNO_AGAIN
)

type wasixListener struct {
	f    *os.File
	addr *net.TCPAddr
}

type wasixConn struct {
	*os.File
	local net.Addr
}

func (c wasixConn) LocalAddr() net.Addr  { return c.local }
func (c wasixConn) RemoteAddr() net.Addr { return &net.TCPAddr{} }

func listenTCP(port uint16) (net.Listener, error) {
	var fd uint32
	if e := sockOpen(afInet4, sockStream, protoTCP, unsafe.Pointer(&fd)); e != 0 {
		return nil, fmt.Errorf("sock_open: %w", syscall.Errno(e))
	}
	// Loopback only: in network host mode the guest's bind is a real host listener,
	// and 0.0.0.0 would expose it on every host interface.
	addr := addrPort{tag: afInet4, port: port, ip: [4]byte{127, 0, 0, 1}}
	if e := sockBind(fd, unsafe.Pointer(&addr)); e != 0 {
		return nil, fmt.Errorf("sock_bind: %w", syscall.Errno(e))
	}
	if e := sockListen(fd, 128); e != 0 {
		return nil, fmt.Errorf("sock_listen: %w", syscall.Errno(e))
	}
	if e := fdFdstatSetFlags(fd, fdNonblock); e != 0 {
		return nil, fmt.Errorf("set nonblock: %w", syscall.Errno(e))
	}
	return &wasixListener{os.NewFile(uintptr(fd), "wasix-listener"), &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(port)}}, nil
}

func (l *wasixListener) Accept() (net.Conn, error) {
	rc, err := l.f.SyscallConn()
	if err != nil {
		return nil, err
	}
	var nfd uint32
	var errno uint32
	var peer addrPort
	err = rc.Read(func(fd uintptr) bool {
		errno = sockAcceptV2(uint32(fd), fdNonblock, unsafe.Pointer(&nfd), unsafe.Pointer(&peer))
		return errno != errnoAgain // false => wait for readability and retry
	})
	if err != nil {
		return nil, err
	}
	if errno != 0 {
		return nil, fmt.Errorf("sock_accept: %w", syscall.Errno(errno))
	}
	return wasixConn{os.NewFile(uintptr(nfd), "wasix-conn"), l.addr}, nil
}

func (l *wasixListener) Close() error   { return l.f.Close() }
func (l *wasixListener) Addr() net.Addr { return l.addr }

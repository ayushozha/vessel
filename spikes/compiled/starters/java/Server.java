import java.nio.charset.StandardCharsets;
import org.teavm.interop.Address;
import org.teavm.interop.Import;

/**
 * Plain-Java HTTP JSON server compiled by TeaVM's WASI target. TeaVM's class
 * library has no java.net.ServerSocket, so the socket calls are Wasmer's
 * WASIX syscalls imported directly (the same ones C's socket() uses).
 * Single-threaded: connections are served one at a time.
 */
public class Server {
    private static final int AF_INET4 = 1;
    private static final int SOCK_STREAM = 1;
    private static final int PROTO_TCP = 6;

    public static void main(String[] args) {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 8080;
        int server = listen(port);
        if (server < 0) {
            System.out.println("listen failed on " + port + ": errno " + -server);
            return;
        }
        System.out.println("listening on " + port);
        byte[] buf = new byte[4096];
        long hits = 0;
        int[] out = new int[1];
        while (true) {
            if (Wasi.sockAccept(server, 0, Address.ofData(out)) != 0) {
                continue;
            }
            int client = out[0];
            int n = io(client, buf, buf.length, false);
            String request = n > 0 ? new String(buf, 0, n, StandardCharsets.UTF_8) : "";
            String[] line = request.split(" ", 3);
            String path = line.length > 1 ? line[1] : "/";
            String body = "{\"lang\":\"java\",\"runtime\":\"teavm-wasi+wasix-sockets\",\"hits\":" + (++hits)
                    + ",\"path\":\"" + path.replace("\"", "") + "\"}";
            byte[] res = ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                    + body.getBytes(StandardCharsets.UTF_8).length + "\r\nConnection: close\r\n\r\n" + body)
                    .getBytes(StandardCharsets.UTF_8);
            writeAll(client, res);
            Wasi.fdClose(client);
        }
    }

    /** Opens a listening IPv4 TCP socket; returns the fd or -errno. */
    static int listen(int port) {
        int[] fd = new int[1];
        int err = Wasix.sockOpen(AF_INET4, SOCK_STREAM, PROTO_TCP, Address.ofData(fd));
        if (err != 0) {
            return -err;
        }
        // __wasi_addr_port_t for IPv4: u8 tag, u8 pad, u16 port (host order), 4 address bytes.
        byte[] addr = new byte[40];
        addr[0] = AF_INET4;
        addr[2] = (byte) port;
        addr[3] = (byte) (port >> 8);
        // Loopback only: in network host mode the guest's bind is a real host listener,
        // and 0.0.0.0 would expose it on every host interface.
        addr[4] = 127;
        addr[7] = 1;
        err = Wasix.sockBind(fd[0], Address.ofData(addr));
        if (err == 0) {
            err = Wasix.sockListen(fd[0], 128);
        }
        return err == 0 ? fd[0] : -err;
    }

    static void writeAll(int fd, byte[] data) {
        byte[] rest = data;
        while (rest.length > 0) {
            int n = io(fd, rest, rest.length, true);
            if (n <= 0) {
                return;
            }
            rest = java.util.Arrays.copyOfRange(rest, n, rest.length);
        }
    }

    /** One fd_read/fd_write through a single iovec; returns bytes moved or -errno. */
    static int io(int fd, byte[] data, int len, boolean write) {
        int[] iov = { Address.ofData(data).toInt(), len };
        int[] done = new int[1];
        int err = write
                ? Wasi.fdWrite(fd, Address.ofData(iov), 1, Address.ofData(done))
                : Wasi.fdRead(fd, Address.ofData(iov), 1, Address.ofData(done));
        return err == 0 ? done[0] : -err;
    }

    static final class Wasix {
        @Import(module = "wasix_32v1", name = "sock_open")
        static native int sockOpen(int af, int type, int proto, Address fdOut);

        @Import(module = "wasix_32v1", name = "sock_bind")
        static native int sockBind(int fd, Address addr);

        @Import(module = "wasix_32v1", name = "sock_listen")
        static native int sockListen(int fd, int backlog);
    }

    static final class Wasi {
        @Import(module = "wasi_snapshot_preview1", name = "sock_accept")
        static native int sockAccept(int fd, int flags, Address fdOut);

        @Import(module = "wasi_snapshot_preview1", name = "fd_read")
        static native int fdRead(int fd, Address iovs, int iovsLen, Address nread);

        @Import(module = "wasi_snapshot_preview1", name = "fd_write")
        static native int fdWrite(int fd, Address iovs, int iovsLen, Address nwritten);

        @Import(module = "wasi_snapshot_preview1", name = "fd_close")
        static native int fdClose(int fd);
    }
}

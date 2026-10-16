import java.util.ArrayList;
import java.util.List;

public class Hello {
    public static void main(String[] args) {
        List<String> parts = new ArrayList<>(List.of("hello", "from", "Java"));
        parts.add("(TeaVM WASI target, run in a Wasmer sandbox)");
        System.out.println(String.join(" ", parts));
    }
}

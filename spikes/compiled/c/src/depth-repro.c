// Repro: the in-sandbox clang/clang 16 frontend crashes (exit 11) on modest nesting.
// Each construct below compiles with 8 / 3 levels; 16 / 4 levels crash.
// This is what blocks compiling generated C (e.g. TeaVM's Java->C output) in-sandbox.
// Run: node c/spike.mjs --depth-repro
struct L0 { int size; };
struct L1 { struct L0 parent; };
struct L2 { struct L1 parent; };
struct L3 { struct L2 parent; };
struct L4 { struct L3 parent; };

struct L4 nested = { .parent = { .parent = { .parent = { .parent = { .size = 8 } } } } }; // 4 levels: crash

int main(void) {
  return ((((((((((((((((0)))))))))))))))) + nested.parent.parent.parent.parent.size; // 16 parens: crash
}

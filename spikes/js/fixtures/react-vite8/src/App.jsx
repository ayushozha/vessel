import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Built inside a Wasmer sandbox</h1>
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
    </main>
  );
}

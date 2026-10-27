"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import styles from "./onboarding.module.css";

type Start = { id: string; authUrl: string; signupUrl: string };
type Status = { state: "waiting" | "connected" | "cancelled" | "expired" | "failed"; username?: string; error?: string };

const OUTCOMES: Partial<Record<Status["state"], string>> = {
  cancelled: "You declined on wasmer.io. Nothing was saved.",
  expired: "That sign-in took longer than 10 minutes. Start again.",
};

/** Step 1: sign in with Wasmer. New users create their wasmer.io account in the same flow. */
export function WasmerSignIn() {
  const router = useRouter();
  const [login, setLogin] = useState<(Start & { via: "authUrl" | "signupUrl" }) | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const begin = async (via: "authUrl" | "signupUrl") => {
    // Open the tab inside the click, before awaiting, so the browser does not block it as a popup.
    const tab = window.open("", "_blank");
    setMessage(null);
    try {
      const res = await fetch("/api/wasmer/login", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      const start = body as Start;
      if (tab) {
        tab.opener = null;
        tab.location.href = start[via];
      }
      setBlocked(!tab);
      setLogin({ ...start, via });
    } catch (e) {
      tab?.close();
      setMessage((e as Error).message);
    }
  };

  const cancel = () => {
    if (login) void fetch(`/api/wasmer/login?id=${encodeURIComponent(login.id)}`, { method: "DELETE" });
    setLogin(null);
  };

  useEffect(() => {
    if (!login) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/wasmer/login?id=${encodeURIComponent(login.id)}`).catch(() => null);
      if (!res?.ok) return;
      const status = (await res.json()) as Status;
      if (status.state === "waiting") return;
      clearInterval(timer);
      setLogin(null);
      if (status.state === "connected") router.refresh();
      else setMessage(status.error ?? OUTCOMES[status.state] ?? "Sign-in failed. Try again.");
    }, 1500);
    return () => clearInterval(timer);
  }, [login, router]);

  return (
    <main className={styles.page}>
      <header className={styles.mark}>
        <b>Adorable</b>
        <span>Step 1 · Sign in with Wasmer</span>
      </header>

      <div className={styles.grid}>
        <section className={styles.intro}>
          <h1 className={styles.title}>
            Your apps run on <span className={styles.u}>Wasmer.</span>
          </h1>
          <p className={styles.sub}>
            Adorable runs and publishes everything you build on Wasmer, under your own Wasmer account. New here? You create the account on
            wasmer.io as part of signing in, and it stays linked to Adorable.
          </p>
          {message && (
            <p className={styles.err} role="status">
              {message}
            </p>
          )}
        </section>

        <section className={styles.panel} aria-live="polite">
          <div className={styles.stack}>
            <div className={styles.panelHead}>
              <h2>Wasmer</h2>
              <span className={styles.chips}>
                <span className={styles.chip}>{login ? "Waiting for wasmer.io" : "Not signed in"}</span>
              </span>
            </div>
            {login ? (
              <>
                <p className={styles.muted}>
                  Finish in the wasmer.io tab: {login.via === "signupUrl" ? "create your account, then " : "sign in or create an account, then "}
                  authorize Adorable. This page continues on its own.
                </p>
                {blocked && <p className={styles.note}>Your browser blocked the new tab.</p>}
                <div className={styles.row}>
                  <a className={styles.mono} href={login[login.via]} target="_blank" rel="noopener noreferrer">
                    Open wasmer.io again
                  </a>
                  <button type="button" className={styles.link} onClick={cancel}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <button type="button" className={`${styles.btn} ${styles.wasmer}`} onClick={() => begin("authUrl")}>
                  Continue with Wasmer
                </button>
                <button type="button" className={styles.link} onClick={() => begin("signupUrl")}>
                  New to Wasmer? Create an account
                </button>
              </>
            )}
            <p className={styles.muted}>
              Adorable receives a personal Wasmer API token named “adorable”, stored only in your local credentials file. You can revoke it any
              time in your Wasmer settings.
            </p>
          </div>
        </section>
      </div>

      <footer className={styles.footer}>
        <span>Next · Step 2 · Connect a model</span>
      </footer>
    </main>
  );
}

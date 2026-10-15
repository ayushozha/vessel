"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import styles from "./onboarding.module.css";

type ProviderId = "chatgpt" | "openai" | "anthropic" | "glm";
type Model = { id: string; label: string };
type KeyStatus = { id: Exclude<ProviderId, "chatgpt">; connected: boolean; keyHint?: string; region?: string; model?: string; verified?: boolean };
type Status = {
  active?: ProviderId;
  keys: KeyStatus[];
  chatgpt: { connected: boolean; email?: string; model?: string; localMode: { enabled: boolean; reason: string | null } };
};

const OPTIONS: { id: ProviderId; name: string; detail: string; color: string }[] = [
  { id: "chatgpt", name: "ChatGPT", detail: "Use your ChatGPT plan", color: "var(--s4)" },
  { id: "openai", name: "OpenAI", detail: "API key", color: "var(--s5)" },
  { id: "anthropic", name: "Anthropic", detail: "API key", color: "var(--s2)" },
  { id: "glm", name: "GLM", detail: "Z.ai or BigModel key", color: "var(--s6)" },
];

const CHATGPT_MESSAGES: Record<string, string> = {
  connected: "ChatGPT connected.",
  access_denied: "You declined access in ChatGPT. Nothing was saved.",
  unavailable: "ChatGPT local mode is off. See the note in the ChatGPT panel.",
  unreachable: "Could not reach OpenAI sign-in. Check your connection and try again.",
  sign_in_expired: "That sign-in took longer than 10 minutes. Start again.",
  plan_usage_not_granted: "ChatGPT signed you in but did not grant plan usage, so it cannot be used for coding.",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function Onboarding({ chatgptResult }: { chatgptResult?: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<ProviderId>("chatgpt");
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/providers"));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load of server state
    void refresh();
  }, [refresh]);

  const connectedOf = (id: ProviderId) =>
    id === "chatgpt" ? status?.chatgpt.connected : status?.keys.find((k) => k.id === id)?.connected;
  const activeModel =
    status?.active === "chatgpt" ? status.chatgpt.model : status?.keys.find((k) => k.id === status?.active)?.model;
  const resultMessage = chatgptResult
    ? (CHATGPT_MESSAGES[chatgptResult] ?? `ChatGPT sign-in failed (${chatgptResult.replaceAll("_", " ")}).`)
    : null;

  return (
    <main className={styles.page}>
      <header className={styles.mark}>
        <b>Vessel</b>
        <span>Step 1 · Connect a model</span>
      </header>

      <div className={styles.grid}>
        <section className={styles.intro}>
          <h1 className={styles.title}>
            Bring your own <span className={styles.u}>intelligence.</span>
          </h1>
          <p className={styles.sub}>Pick where Vessel’s coding agent gets its model. Keys stay on this machine.</p>
          {resultMessage && (
            <p className={chatgptResult === "connected" ? styles.ok : styles.err} role="status">
              {resultMessage}
            </p>
          )}
          {loadError && <p className={styles.err}>{loadError}</p>}

          <div className={styles.options} role="radiogroup" aria-label="Model provider">
            {OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={selected === o.id}
                className={styles.option}
                data-selected={selected === o.id}
                onClick={() => setSelected(o.id)}
              >
                <i style={{ background: o.color }} />
                <span className={styles.optName}>{o.name}</span>
                <span className={styles.optDetail}>{o.detail}</span>
                <span className={styles.optState}>
                  {status?.active === o.id ? "Active" : connectedOf(o.id) ? "Connected" : ""}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className={styles.panel} aria-live="polite">
          {!status ? (
            <p className={styles.muted}>Loading…</p>
          ) : selected === "chatgpt" ? (
            <ChatgptPanel status={status} onChange={refresh} />
          ) : (
            <KeyPanel key={selected} status={status.keys.find((k) => k.id === selected)!} onChange={refresh} />
          )}
        </section>
      </div>

      <footer className={styles.footer}>
        {status?.active && activeModel ? (
          <>
            <span>
              Ready · {OPTIONS.find((o) => o.id === status.active)?.name} · <b>{activeModel}</b>
            </span>
            <Link href="/new" className={styles.continue}>
              Continue →
            </Link>
          </>
        ) : (
          <span>Connect a provider and choose a model to continue.</span>
        )}
      </footer>
    </main>
  );
}

function ModelPicker({ provider, current, initial, onChange }: { provider: ProviderId; current?: string; initial?: Model[]; onChange: () => void }) {
  const [models, setModels] = useState<Model[] | null>(initial ?? null);
  const [choice, setChoice] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initial) return;
    api<{ models: Model[] }>(`/api/providers/models?provider=${provider}`)
      .then((r) => setModels(r.models))
      .catch((e: Error) => {
        setModels([]);
        setError(e.message);
      });
  }, [provider, initial]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("/api/providers", { method: "PATCH", body: JSON.stringify({ provider, model: choice }) });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.field}>
      <label htmlFor={`model-${provider}`} className={styles.label}>
        Model
      </label>
      {models === null ? (
        <p className={styles.muted}>Loading models from the provider…</p>
      ) : models.length ? (
        <select id={`model-${provider}`} className={styles.input} value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a model ({models.length} available)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label === m.id ? m.id : `${m.label} · ${m.id}`}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={`model-${provider}`}
          className={styles.input}
          placeholder="Model ID, as listed in your provider’s docs"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        />
      )}
      {error && <p className={styles.err}>{error}</p>}
      <button type="button" className={styles.btn} disabled={!choice.trim() || saving} onClick={save}>
        {saving ? "Saving…" : current === choice && current ? "In use" : "Use this model"}
      </button>
    </div>
  );
}

function KeyPanel({ status, onChange }: { status: KeyStatus; onChange: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState<"global" | "china">("global");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ models: Model[]; verified: boolean } | null>(null);
  const name = OPTIONS.find((o) => o.id === status.id)!.name;

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { provider: status.id, apiKey, ...(status.id === "glm" ? { region } : {}) };
      setFresh(await api("/api/providers", { method: "POST", body: JSON.stringify(body) }));
      setApiKey("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api(`/api/providers?provider=${status.id}`, { method: "DELETE" });
    setFresh(null);
    onChange();
  };

  if (status.connected) {
    const verified = fresh?.verified ?? status.verified;
    return (
      <div className={styles.stack}>
        <PanelHead name={name} state="Connected" />
        <div className={styles.row}>
          <span className={styles.mono}>
            Key {status.keyHint}
            {status.region ? ` · ${status.region === "china" ? "BigModel (China)" : "Z.ai (global)"}` : ""}
          </span>
          <button type="button" className={styles.link} onClick={remove}>
            Remove
          </button>
        </div>
        {verified === false && (
          <p className={styles.note}>The provider’s model list wasn’t available, so the key could not be verified yet. Enter a model ID.</p>
        )}
        <ModelPicker provider={status.id} current={status.model} initial={fresh?.models} onChange={onChange} />
      </div>
    );
  }

  return (
    <form className={styles.stack} onSubmit={connect}>
      <PanelHead name={name} state="Not connected" />
      {status.id === "glm" && (
        <div className={styles.field}>
          <span className={styles.label}>Endpoint</span>
          <div className={styles.segmented} role="radiogroup" aria-label="GLM endpoint">
            {(["global", "china"] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={region === r} data-selected={region === r} onClick={() => setRegion(r)}>
                {r === "global" ? "Z.ai · global" : "BigModel · China"}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={styles.field}>
        <label htmlFor={`key-${status.id}`} className={styles.label}>
          API key
        </label>
        <input
          id={`key-${status.id}`}
          className={styles.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={`Paste your ${name} API key`}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      {error && <p className={styles.err}>{error}</p>}
      <button type="submit" className={styles.btn} disabled={busy || apiKey.trim().length < 8}>
        {busy ? "Checking key…" : "Connect"}
      </button>
      <p className={styles.muted}>We check the key against the provider’s model list, then store it in your local Vessel credentials file.</p>
    </form>
  );
}

function ChatgptPanel({ status, onChange }: { status: Status; onChange: () => void }) {
  const { chatgpt } = status;
  const remove = async () => {
    await api("/api/providers?provider=chatgpt", { method: "DELETE" });
    onChange();
  };

  return (
    <div className={styles.stack}>
      <PanelHead name="ChatGPT" state={chatgpt.connected ? "Connected" : "Not connected"} badge="Local demo mode" />
      {chatgpt.connected ? (
        <>
          <div className={styles.row}>
            <span className={styles.mono}>{chatgpt.email ?? "Signed in"}</span>
            <button type="button" className={styles.link} onClick={remove}>
              Disconnect
            </button>
          </div>
          <ModelPicker provider="chatgpt" current={chatgpt.model} onChange={onChange} />
        </>
      ) : chatgpt.localMode.enabled ? (
        <>
          <p className={styles.muted}>Sign in and allow Vessel to use your ChatGPT plan for coding. Your conversations are not shared.</p>
          <a className={`${styles.btn} ${styles.chatgpt}`} href="/api/chatgpt/start">
            Continue with ChatGPT
          </a>
        </>
      ) : (
        <p className={styles.note}>{chatgpt.localMode.reason}</p>
      )}
      <p className={styles.muted}>
        Uses OpenAI’s documented flow for locally run apps. A hosted version of Vessel needs OpenAI’s approval first.
      </p>
    </div>
  );
}

function PanelHead({ name, state, badge }: { name: string; state: string; badge?: string }) {
  return (
    <div className={styles.panelHead}>
      <h2>{name}</h2>
      <span className={styles.chips}>
        {badge && <span className={styles.chip}>{badge}</span>}
        <span className={styles.chip} data-on={state === "Connected"}>
          {state}
        </span>
      </span>
    </div>
  );
}

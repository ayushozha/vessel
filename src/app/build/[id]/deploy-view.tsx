"use client";

import type { DeployStep } from "@/lib/deploy";

import styles from "./builder.module.css";
import type { useDeploy } from "./use-deploy";

const STEPS: { step: DeployStep; label: string }[] = [
  { step: "packing", label: "Pack the source" },
  { step: "uploading", label: "Upload to Wasmer" },
  { step: "detecting", label: "Detect the stack (Anybuild)" },
  { step: "building", label: "Build" },
  { step: "deploying", label: "Deploy to Wasmer Edge" },
  { step: "live", label: "Live" },
];
const ORDER = STEPS.map((s) => s.step);

/** The Deploy tab: progress of the current publish, its Wasmer build log, and the live app. */
export function DeployView({ deploy }: { deploy: ReturnType<typeof useDeploy> }) {
  const job = deploy.status?.job;
  const deployment = deploy.status?.deployment;

  if (!job && !deploy.active) {
    return (
      <div className={styles.deploy}>
        {deploy.error && <p className={styles.errorBox}>{deploy.error}</p>}
        {deployment?.url ? (
          <LiveCard url={deployment.url} adminUrl={deployment.adminUrl} appName={deployment.appName} version={deployment.version} at={deployment.publishedAt} />
        ) : (
          <div className={styles.empty}>
            <strong>Not published yet.</strong>
            <p>Publish sends this project to Wasmer Edge in one click. Anybuild detects the stack, builds it and gives you a live URL.</p>
          </div>
        )}
      </div>
    );
  }

  // A failed publish lights the step it stopped at.
  const failed = job?.step === "failed";
  const reached = ORDER.indexOf((failed ? job.failedAt : job?.step) ?? "packing");

  return (
    <div className={styles.deploy}>
      {deploy.error && <p className={styles.errorBox}>{deploy.error}</p>}
      {job?.step === "live" && job.url && (
        <LiveCard url={job.url} adminUrl={deployment?.adminUrl} appName={deployment?.appName} version={deployment?.version} at={job.finishedAt} />
      )}
      {failed && job.error && <p className={styles.errorBox}>{job.error}</p>}
      <ul className={styles.list}>
        {STEPS.map(({ step, label }, i) => {
          const state = i < reached || job?.step === "live" ? "done" : i === reached ? (failed ? "error" : "on") : "idle";
          return (
            <li key={step} data-step={state}>
              <i />
              <span>
                {label}
                {step === "detecting" && job?.preset ? ` · ${job.preset}` : ""}
              </span>
              <em>{state === "done" ? "Done" : state === "on" ? "Working" : state === "error" ? "Failed" : ""}</em>
            </li>
          );
        })}
      </ul>
      <pre className={`${styles.logs} ${styles.deployLog}`}>
        {job?.logs.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
        {deploy.active && <span className={styles.caret} />}
      </pre>
    </div>
  );
}

function LiveCard({ url, adminUrl, appName, version, at }: { url: string; adminUrl?: string; appName?: string; version?: string; at?: string }) {
  return (
    <div className={styles.liveCard}>
      <span className={styles.cardLabel}>Live on Wasmer Edge{version ? ` · ${version}` : ""}</span>
      <a href={url} target="_blank" rel="noopener noreferrer">
        {url.replace(/^https?:\/\//, "")} ↗
      </a>
      <span className={styles.muted}>
        {appName}
        {at ? ` · published ${new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}
        {adminUrl && (
          <>
            {" · "}
            <a href={adminUrl} target="_blank" rel="noopener noreferrer">
              Open in Wasmer
            </a>
          </>
        )}
      </span>
    </div>
  );
}

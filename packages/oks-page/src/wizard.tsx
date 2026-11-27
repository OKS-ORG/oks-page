"use client";
// The setup wizard (installation guide, "First run"): two questions about the site, two about the owner, one about starter
// content, then it signs the owner in. Drawn as the design shows: a bar of steps, a kicker, a title and a line under it, the
// fields, and Back and Continue at the foot. Language, look, two-factor and backup codes come with their own parts.
import { Alert, PasswordField, TextField } from "oks-ui";
import { useState, type FormEvent } from "react";
import { ChoiceCard } from "./choice-card";

const PURPOSES: { label: string; note: string; value: string; d: string }[] = [
  { label: "A blog", note: "Posts and news", value: "blog", d: "M6 3h9l4 4v14H6z M14 3v5h5" },
  { label: "A business", note: "Your services", value: "business", d: "M3 8h18v12H3z M9 8V5h6v3" },
  {
    label: "A portfolio",
    note: "Show your work",
    value: "portfolio",
    d: "M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6",
  },
  { label: "Other", note: "Start plain", value: "other", d: "M12 5v14M5 12h14" },
];

const SITE_FIELDS = ["siteName", "tagline", "purpose"];
const ACCOUNT_FIELDS = ["name", "email", "password"];

const STEPS = [
  {
    key: "site",
    title: "Tell us about your site",
    line: "This picks sensible defaults. You can change them later.",
  },
  {
    key: "account",
    title: "Create your admin account",
    line: "You use this to sign in and look after your site.",
  },
  {
    key: "starter",
    title: "Add some starter content?",
    line: "Sample pages help you see how your site looks. Delete them in one click.",
  },
];

interface ApiError {
  code: string;
  field?: string;
  message: string;
}

/** How strong a password looks to its owner: by length only, and the server still decides (at least 10 characters). */
function strength(password: string): { level: number; word: string } {
  if (password.length === 0) return { level: 0, word: "" };
  if (password.length < 10) return { level: 1, word: "Too short" };
  if (password.length < 14) return { level: 2, word: "Fine" };
  if (password.length < 18) return { level: 3, word: "Good" };
  return { level: 4, word: "Strong password" };
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const Choice = ChoiceCard;

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The answers are kept here: only the fields of the step on screen exist, so a field of an earlier step would be lost
  // when the next step is shown.
  const [answers, setAnswers] = useState({
    siteName: "",
    tagline: "",
    purpose: "blog",
    name: "",
    email: "",
    password: "",
    starter: "sample",
  });
  const set = (key: keyof typeof answers) => (value: string) =>
    setAnswers((current) => ({ ...current, [key]: value }));

  async function submit() {
    setProblem(null);
    setBusy(true);
    const body = {
      siteName: answers.siteName,
      tagline: answers.tagline,
      purpose: answers.purpose,
      starterContent: answers.starter === "sample",
      // The site starts in the time zone of this browser; the owner can change it in Settings, General.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      admin: { name: answers.name, email: answers.email, password: answers.password },
    };
    let response: Response;
    try {
      response = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setProblem("The site could not be reached. Check your connection and try again.");
      setBusy(false);
      return;
    }
    if (response.ok) {
      setEmail(body.admin.email);
      return;
    }
    const error = ((await response.json().catch(() => null)) as { error?: ApiError } | null)?.error;
    setProblem(error?.message ?? "Setup did not finish. Try again.");
    // A wrong answer goes back to the step that asked the question.
    if (error?.field && SITE_FIELDS.includes(error.field)) setStep(0);
    else if (error?.field && ACCOUNT_FIELDS.includes(error.field)) setStep(1);
    setBusy(false);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    void submit();
  }

  if (email)
    return (
      <section aria-labelledby="done" className="oks-wizard">
        <div className="oks-wizard-bar" role="img" aria-label="Setup finished">
          {STEPS.map((s) => (
            <span key={s.key} data-on="true" />
          ))}
        </div>
        <p className="oks-wizard-kicker">All done</p>
        <h1 id="done">Your site is ready</h1>
        <p className="oks-wizard-line">You are signed in as {email}.</p>
        <p>
          <strong>Recommended:</strong> turn on two-factor sign-in for your account. It asks for a
          code from an app on your phone as well as your password. It takes about a minute, and you
          can skip it and do it later on Your account.
        </p>
        <ul className="oks-next-rows">
          <li>
            <a href="/admin/account">
              <span className="oks-next-title">Set up two-factor sign-in</span>
              <span className="oks-next-note">Recommended. About one minute.</span>
            </a>
          </li>
          <li>
            <a href="/admin">
              <span className="oks-next-title">Skip for now: open the dashboard</span>
              <span className="oks-next-note">Write pages, add pictures, change the look.</span>
            </a>
          </li>
          <li>
            <a href="/">
              <span className="oks-next-title">View your site</span>
              <span className="oks-next-note">See it as your visitors do.</span>
            </a>
          </li>
        </ul>
        <p className="oks-wizard-privacy">
          Your data stays on your server. No tracking, and no cookies for visitors by default.
        </p>
      </section>
    );

  const current = STEPS[step]!;
  const last = step === STEPS.length - 1;
  const pw = strength(answers.password);
  return (
    <div className="oks-wizard">
      <div className="oks-wizard-bar" role="img" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <span key={s.key} data-on={i <= step} />
        ))}
      </div>
      <p className="oks-wizard-kicker">{`Step ${step + 1} of ${STEPS.length}`}</p>
      <h1>{current.title}</h1>
      <p className="oks-wizard-line">{current.line}</p>
      {problem ? <Alert color="danger" title="Setup did not finish" description={problem} /> : null}
      <form aria-label="Set up your site" onSubmit={onSubmit}>
        {step === 0 ? (
          <>
            <TextField
              name="siteName"
              label="Site name"
              required
              value={answers.siteName}
              onChange={set("siteName")}
            />
            <TextField
              name="tagline"
              label="Tagline"
              description="A short line under the name. You can leave it empty."
              value={answers.tagline}
              onChange={set("tagline")}
            />
            <fieldset className="oks-choices">
              <legend>What is the site for?</legend>
              <div className="oks-choice-grid" data-columns="4">
                {PURPOSES.map((p) => (
                  <Choice
                    key={p.value}
                    name="purpose"
                    value={p.value}
                    checked={answers.purpose === p.value}
                    onChange={set("purpose")}
                  >
                    <Icon d={p.d} />
                    <span className="oks-choice-name">{p.label}</span>
                    <span className="oks-choice-note">{p.note}</span>
                  </Choice>
                ))}
              </div>
            </fieldset>
          </>
        ) : null}
        {step === 1 ? (
          <>
            <TextField
              name="name"
              label="Your name"
              required
              value={answers.name}
              onChange={set("name")}
            />
            <TextField
              name="email"
              label="Email"
              type="email"
              required
              value={answers.email}
              onChange={set("email")}
            />
            <div>
              <PasswordField
                name="password"
                label="Password"
                description="At least 10 characters."
                required
                value={answers.password}
                onChange={set("password")}
              />
              <div className="oks-strength" data-level={pw.level}>
                <span />
                <span />
                <span />
                <span />
              </div>
              <p className="oks-strength-word" role="status">
                {pw.word}
              </p>
            </div>
          </>
        ) : null}
        {step === 2 ? (
          <fieldset className="oks-choices oks-choices-quiet">
            <legend>Add sample content?</legend>
            <div className="oks-choice-grid" data-columns="2">
              <Choice
                name="starter"
                value="sample"
                checked={answers.starter === "sample"}
                onChange={set("starter")}
              >
                <span className="oks-choice-name">Add sample pages</span>
                <span className="oks-choice-note">Home, About, Contact and a first post</span>
                <span className="oks-choice-help">Good for learning. Delete them any time.</span>
              </Choice>
              <Choice
                name="starter"
                value="empty"
                checked={answers.starter === "empty"}
                onChange={set("starter")}
              >
                <span className="oks-choice-name">Start with an empty site</span>
                <span className="oks-choice-note">A blank site</span>
                <span className="oks-choice-help">You add your own pages.</span>
              </Choice>
            </div>
          </fieldset>
        ) : null}
        <div className="oks-wizard-foot">
          {step > 0 ? (
            <button type="button" className="oks-text-button" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <span />
          )}
          <button type="submit" className="oks-main-button" disabled={busy}>
            {last ? "Finish setup" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}

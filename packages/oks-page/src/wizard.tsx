"use client";
// The setup wizard (installation guide, "First run"): two questions about the site, two about the owner, then it
// signs the owner in. Built with oks-ui's SteppedForm. Language, look and starter content come with their own parts.
import { Alert, PasswordField, RadioGroupField, SteppedForm, TextField } from "oks-ui";
import { useState } from "react";

const PURPOSES = [
  { label: "A blog", value: "blog" },
  { label: "A business", value: "business" },
  { label: "A portfolio", value: "portfolio" },
  { label: "Something else", value: "other" },
];

const STARTER = [
  { label: "Add sample pages (Home, About, Contact) and a first post", value: "sample" },
  { label: "Start with an empty site", value: "empty" },
];

const SITE_FIELDS = ["siteName", "tagline", "purpose"];
const ACCOUNT_FIELDS = ["name", "email", "password"];

interface ApiError {
  code: string;
  field?: string;
  message: string;
}

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  // The answers are kept here: the form only holds the fields of the step on screen, so a field of an earlier step
  // would be lost when the next step is shown.
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
    const body = {
      siteName: answers.siteName,
      tagline: answers.tagline,
      purpose: answers.purpose,
      starterContent: answers.starter === "sample",
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
  }

  if (email)
    return (
      <section aria-labelledby="done">
        <h2 id="done">Your site is set up</h2>
        <p>You are signed in as {email}.</p>
        <p>
          <a href="/admin">Open the dashboard</a> · <a href="/">View your site</a>
        </p>
      </section>
    );

  return (
    <>
      {problem ? <Alert color="danger" title="Setup did not finish" description={problem} /> : null}
      <SteppedForm
        aria-label="Set up your site"
        stepIndex={step}
        onStepChange={setStep}
        onSubmit={submit}
        submitLabel="Finish setup"
        steps={[
          {
            key: "site",
            title: "Your site",
            fields: SITE_FIELDS,
            content: (
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
                <RadioGroupField
                  name="purpose"
                  label="What is the site for?"
                  options={PURPOSES}
                  value={answers.purpose}
                  onChange={(value: string) => set("purpose")(value)}
                />
              </>
            ),
          },
          {
            key: "account",
            title: "Your account",
            fields: ACCOUNT_FIELDS,
            content: (
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
                <PasswordField
                  name="password"
                  label="Password"
                  description="At least 10 characters."
                  required
                  value={answers.password}
                  onChange={set("password")}
                />
              </>
            ),
          },
          {
            key: "starter",
            title: "Starter content",
            fields: ["starter"],
            content: (
              <RadioGroupField
                name="starter"
                label="Add sample content?"
                options={STARTER}
                value={answers.starter}
                onChange={(value: string) => set("starter")(value)}
              />
            ),
          },
        ]}
      />
    </>
  );
}

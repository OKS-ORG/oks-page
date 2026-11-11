// Test builds only: a form that calls the Server Action.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { saveTitle } from "./actions";

export default async function TestForm() {
  await connection();
  if (!process.env["OKS_TEST"]) notFound();
  return (
    <form action={saveTitle}>
      <input name="id" aria-label="id" />
      <input name="title" aria-label="title" />
      <button type="submit">Save</button>
    </form>
  );
}

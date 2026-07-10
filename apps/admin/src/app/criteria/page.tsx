/**
 * /criteria — edit matching criteria (spec 08 §3).
 * Form bound to criteria.value, validated with the Criteria zod schema on submit.
 * Invalid input shows field-level errors and writes nothing.
 */
import { getCriteria } from "@jobscout/core";
import { getDb } from "../../lib/db";
import { requireAllowedUser } from "../../lib/auth";
import { updateCriteriaAction } from "../../lib/actions";

export default async function CriteriaPage() {
  // Redirects (null session) or 403s (non-allowlisted) before any DB access.
  await requireAllowedUser();

  const db = getDb();
  const criteria = await getCriteria(db);

  return (
    <div>
      <h1>Matching Criteria</h1>
      <p>Edit the JSON below and submit to update. Changes take effect on the next crawl.</p>
      <CriteriaForm defaultValue={criteria} />
    </div>
  );
}

function CriteriaForm({ defaultValue }: { defaultValue: unknown }) {
  async function submitCriteria(formData: FormData) {
    "use server";
    const raw = formData.get("criteria_json") as string;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    await updateCriteriaAction(parsed);
  }

  return (
    <form action={submitCriteria}>
      <textarea
        name="criteria_json"
        rows={40}
        cols={80}
        defaultValue={JSON.stringify(defaultValue, null, 2)}
        style={{ fontFamily: "monospace", fontSize: "0.85em" }}
      />
      <br />
      <button type="submit">Save criteria</button>
    </form>
  );
}

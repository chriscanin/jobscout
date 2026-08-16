/**
 * /criteria — edit matching criteria (spec 08 §3).
 * Form bound to criteria.value, validated with the Criteria zod schema on submit.
 * Invalid input shows field-level errors and writes nothing.
 */
import { getCriteria } from "@jobscout/core";
import { getDb } from "../../lib/db";
import { requireAllowedUser } from "../../lib/auth";
import { updateCriteriaAction } from "../../lib/actions";

/**
 * Live data + a per-visitor view (the pipeline is shown only to the owner),
 * so this must never be prerendered at build time.
 */
export const dynamic = "force-dynamic";


export default async function CriteriaPage() {
  // Redirects (null session) or 403s (non-allowlisted) before any DB access.
  await requireAllowedUser();

  const db = getDb();
  const criteria = await getCriteria(db);

  return (
    <div>
      <section className="rise">
        <p className="kicker">The brief</p>
        <h1>Matching criteria</h1>
        <p className="lede">
          Edit the JSON and save — the next crawl scores against it. Invalid
          JSON or schema violations write nothing.
        </p>
      </section>

      <section className="section rise">
        <div className="panel">
          <CriteriaForm defaultValue={criteria} />
        </div>
      </section>
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
        rows={34}
        defaultValue={JSON.stringify(defaultValue, null, 2)}
      />
      <p style={{ marginTop: "0.6rem" }}>
        <button type="submit" className="btn btn-primary">
          Save criteria
        </button>
      </p>
    </form>
  );
}

/**
 * /criteria — edit matching criteria (spec 08 §3).
 * Form bound to criteria.value, validated with the Criteria zod schema on submit.
 * Invalid input shows field-level errors and writes nothing.
 */
import { getCriteria } from "@jobscout/core";
import { getDb } from "../../lib/db";
import { getViewer } from "../../lib/viewer";
import { updateCriteriaAction } from "../../lib/actions";

/**
 * Reads live data, so it must not be prerendered at build time.
 */
export const dynamic = "force-dynamic";


export default async function CriteriaPage() {

  const db = getDb();
  const [criteria, viewer] = await Promise.all([getCriteria(db), getViewer()]);

  return (
    <div>
      <section className="rise">
        <p className="kicker">The brief</p>
        <h1>Matching criteria</h1>
        <p className="lede">
          {viewer?.is_owner
            ? "Edit the JSON and save; the next crawl scores against it. Invalid JSON or schema violations write nothing."
            : "What every posting is scored against. Only the board owner can change it."}
        </p>
      </section>

      <section className="section rise">
        <div className="panel">
          {viewer?.is_owner ? (
            <CriteriaForm defaultValue={criteria} />
          ) : (
            <pre className="raw">{JSON.stringify(criteria, null, 2)}</pre>
          )}
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

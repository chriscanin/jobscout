/**
 * /people — the owner's list of who can track postings on the board. Add a
 * person to get their invite link, issue a new link if one leaks (the old one
 * stops working, their tracking is kept), or remove them. Owner only; anyone
 * else gets a 404.
 */
import { notFound } from "next/navigation";
import { listPeople } from "@jobscout/core";
import { getDb } from "../../lib/db";
import { getViewer } from "../../lib/viewer";
import { removePersonAction } from "../../lib/actions";
import { AddPersonForm, NewLinkButton } from "../../lib/invite-forms";
import { shortDate } from "../../lib/chips";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const viewer = await getViewer();
  if (!viewer?.is_owner) notFound();

  const people = await listPeople(getDb());

  return (
    <div>
      <section className="rise">
        <p className="kicker">The crew</p>
        <h1>People</h1>
        <p className="lede">
          Everyone can browse the board. To queue, mark applied, dismiss or keep
          notes, a person opens their invite link once on their browser. Each
          person&apos;s tracking is their own.
        </p>
      </section>

      <section className="section rise">
        <AddPersonForm />
        <div className="ledger-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Name</th>
                <th>Added</th>
                <th>Last joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td className="title-cell">
                    {p.name}
                    {p.is_owner && <span className="muted"> (owner)</span>}
                  </td>
                  <td className="muted">{shortDate(p.created_at)}</td>
                  <td className="muted">{shortDate(p.last_seen_at)}</td>
                  <td>
                    <NewLinkButton personId={p.id} name={p.name} />
                    {!p.is_owner && (
                      <details className="confirm">
                        <summary className="btn btn-quiet">Remove</summary>
                        <form action={removePersonAction} className="inline-form">
                          <input type="hidden" name="person_id" value={p.id} />
                          <button type="submit" className="btn btn-quiet">
                            Yes, remove {p.name} and their tracking
                          </button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

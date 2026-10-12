"use client";

/**
 * The owner's invite forms on /people. Client components only so the new link
 * can be shown once, right after it is made, without putting the token in a
 * URL or a cookie.
 */
import { useActionState } from "react";
import { addPersonAction, newLinkAction, type InviteState } from "./actions";

function InviteResult({ state }: { state: InviteState }) {
  if (!state) return null;
  if (!state.ok) return <p className="form-error">{state.error}</p>;
  const link = state.link;
  return (
    <div className="invite-link">
      <p>
        Send this to <b>{state.name}</b>. It signs them in, and it is shown only
        once:
      </p>
      <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

export function AddPersonForm() {
  const [state, action, pending] = useActionState(addPersonAction, null);
  return (
    <form action={action} className="filter-bar">
      <label>
        Name
        <input name="name" required maxLength={60} placeholder="e.g. Sam" />
      </label>
      <button type="submit" className="btn btn-primary" disabled={pending}>
        Add + make link
      </button>
      <InviteResult state={state} />
    </form>
  );
}

export function NewLinkButton({ personId, name }: { personId: string; name: string }) {
  const [state, action, pending] = useActionState(newLinkAction, null);
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="person_id" value={personId} />
      <input type="hidden" name="name" value={name} />
      <button type="submit" className="btn" disabled={pending}>
        New link
      </button>
      <InviteResult state={state} />
    </form>
  );
}

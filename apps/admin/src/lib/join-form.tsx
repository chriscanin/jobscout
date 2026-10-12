"use client";

import { useEffect, useState, useTransition } from "react";
import { joinAction } from "./actions";

/** Reads the invite token from the URL fragment and hands it to joinAction. */
export function JoinForm() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setToken(window.location.hash.slice(1));
  }, []);

  if (token === null) return null;
  if (token === "") {
    return (
      <p className="form-error">
        This page needs the whole invite link, including the part after the #.
      </p>
    );
  }
  return (
    <p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await joinAction(token);
            if (result && !result.ok) setError(result.error);
          })
        }
      >
        Continue
      </button>
      {error && <span className="form-error"> {error}</span>}
    </p>
  );
}

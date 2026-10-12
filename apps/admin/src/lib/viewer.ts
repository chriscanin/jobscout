import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { findPersonByToken, type Person } from "@jobscout/core";
import { getDb } from "./db";

/**
 * Who is looking at the board. Browsing is public; tracking postings needs a
 * person, and a person signs in by opening their invite link (/join#<token>),
 * which stores the token in this httpOnly cookie. Only the token's hash is in
 * the database.
 */
export const PERSON_COOKIE = "jobscout_person";

/** Cookie settings. One year: friends should not have to dig the link out again. */
export const PERSON_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
} as const;

/** The signed-in person for this request, or null. Cached per request. */
export const getViewer = cache(async (): Promise<Person | null> => {
  const token = (await cookies()).get(PERSON_COOKIE)?.value;
  return findPersonByToken(getDb(), token);
});

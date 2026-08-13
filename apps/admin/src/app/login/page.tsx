import { loginAction } from "../../lib/login-action";

interface Props {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { returnTo, error } = await searchParams;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "5rem",
      }}
    >
      <div className="panel" style={{ width: "100%", maxWidth: "380px" }}>
        <div className="kicker" style={{ marginBottom: "0.6rem" }}>
          Admin Access
        </div>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.5rem",
            marginBottom: "1.4rem",
          }}
        >
          Job<span style={{ color: "var(--green)", fontStyle: "italic" }}>Scout</span>
        </h1>

        {error && (
          <p
            className="error-text"
            style={{ marginBottom: "1rem", fontSize: "12.5px" }}
          >
            Incorrect password. Try again.
          </p>
        )}

        <form action={loginAction}>
          {returnTo && (
            <input type="hidden" name="returnTo" value={returnTo} />
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              marginBottom: "1rem",
            }}
          >
            <label
              htmlFor="password"
              style={{
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.13em",
                color: "var(--ink-soft)",
              }}
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              style={{ width: "100%" }}
            />
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}

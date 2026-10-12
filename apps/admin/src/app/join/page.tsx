/**
 * /join#<token> — where an invite link lands. The token sits in the URL
 * fragment, which browsers never send to the server, so it stays out of
 * request logs and link previews cannot sign anyone in. A button posts it to
 * joinAction, which sets the cookie.
 */
import { JoinForm } from "../../lib/join-form";

export default function JoinPage() {
  return (
    <div>
      <section className="rise">
        <p className="kicker">Invite</p>
        <h1>Join the board</h1>
        <p className="lede">
          This signs this browser in so you can keep your own queue: queue,
          mark applied, dismiss and take notes. Nobody else sees your choices.
        </p>
        <JoinForm />
      </section>
    </div>
  );
}

import RegisterForm from "./register-form";

export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="narrow">
        <h1>Create account</h1>
        <div className="card">
          <p>
            Registration is <strong>invite-only</strong>. You need an invite
            link from a server admin to create an account.
          </p>
          <p className="muted">
            Already have an account? <a href="/login">Log in here.</a>
          </p>
        </div>
      </div>
    );
  }

  return <RegisterForm token={token} />;
}

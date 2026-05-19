/**
 * Login page placeholder — wired in a later PR.
 *
 * The real implementation will live in `features/auth/LoginForm.tsx` +
 * `features/auth/OAuthGoogleButton.tsx`; this page is the route entry.
 */
export default function LoginPage() {
  return (
    <main className='flex min-h-screen items-center justify-center bg-background p-6'>
      <div className='w-full max-w-sm rounded-lg border bg-card p-6 text-card-foreground'>
        <h1 className='text-xl font-semibold'>Sign in</h1>
        <p className='mt-2 text-sm text-muted-foreground'>
          Login form arrives with the auth PR. For now this is a route
          placeholder so the router resolves.
        </p>
      </div>
    </main>
  );
}

/**
 * Reset password placeholder — wired in the auth PR.
 */
export default function ResetPasswordPage() {
  return (
    <main className='flex min-h-screen items-center justify-center bg-background p-6'>
      <div className='w-full max-w-sm rounded-lg border bg-card p-6 text-card-foreground'>
        <h1 className='text-xl font-semibold'>Reset password</h1>
        <p className='mt-2 text-sm text-muted-foreground'>
          Reset password form arrives with the auth PR. Route placeholder.
        </p>
      </div>
    </main>
  );
}

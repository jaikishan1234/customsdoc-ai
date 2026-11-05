/**
 * Shared centered shell for authentication pages (/sign-up, later /sign-in).
 */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-[calc(100vh)] flex-1 items-center justify-center bg-zinc-50 px-4 py-12 font-sans dark:bg-black">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

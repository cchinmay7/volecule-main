import { EnvVarWarning } from '@/components/env-var-warning'
import { AuthButton } from '@/components/auth-button'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { hasEnvVars } from '@/utils/env'
import { createClient } from '@/supabase/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { Suspense } from 'react'
import { unstable_noStore as noStore } from 'next/cache'

type ProtectedLayoutProps = {
  children: React.ReactNode
}

const protectedNavLinks = [
  { href: '/protected', label: 'Dashboard' },
  { href: '/protected/projects', label: 'Sites' },
  { href: '/protected/sites', label: 'Projects' },
  { href: '/protected/logs', label: 'Logs' },
]

export default async function ProtectedLayout({
  children,
}: ProtectedLayoutProps) {
  noStore()
  await connection()

  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  if (error || !data?.user) {
    redirect('/auth/login')
  }

  return (
    <main className="flex min-h-screen flex-col items-center">
      <div className="flex w-full flex-1 flex-col items-center gap-8">
        <nav className="border-b-foreground/10 flex h-16 w-full justify-center border-b">
          <div className="flex w-full max-w-5xl items-center justify-between p-3 px-5 text-sm">
            <div className="flex items-center gap-6 font-semibold">
              <Link href={'/protected'}>Volecule Dashboard</Link>
              <div className="text-foreground/70 hidden items-center gap-4 text-xs md:flex">
                {protectedNavLinks.map((link) => (
                  <Link key={link.href} href={link.href}>
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
            {!hasEnvVars ? (
              <EnvVarWarning />
            ) : (
              <Suspense>
                <AuthButton />
              </Suspense>
            )}
          </div>
        </nav>
        <div className="flex max-w-5xl flex-1 flex-col gap-8 p-5">
          <Suspense
            fallback={
              <div className="text-muted-foreground text-sm">Loading...</div>
            }
          >
            {children}
          </Suspense>
        </div>

        <footer className="mx-auto flex w-full items-center justify-center gap-8 border-t py-16 text-center text-xs">
          <p>
            Powered by{' '}
            <a
              href="https://supabase.com/?utm_source=create-next-app&utm_medium=template&utm_term=nextjs"
              target="_blank"
              className="font-bold hover:underline"
              rel="noreferrer"
            >
              Supabase
            </a>
          </p>
          <ThemeSwitcher />
        </footer>
      </div>
    </main>
  )
}

import { redirect } from 'next/navigation'
import { createClient } from '@/supabase/server'

export default async function HomePage() {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  if (error || !data?.user) {
    redirect('/auth/login')
  }

  const allowedEmail = process.env.ALLOWED_LOGIN_EMAIL?.trim().toLowerCase()
  const userEmail = data.user.email?.toLowerCase()
  const isAllowedUser =
    !allowedEmail || Boolean(userEmail && userEmail === allowedEmail)

  if (!isAllowedUser) {
    redirect('/auth/login?error=unauthorized')
  }

  redirect('/protected')
}

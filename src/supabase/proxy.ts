import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { hasEnvVars } from '@/utils/env'

function redirectWithOriginalRequest(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  return NextResponse.redirect(url)
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  if (!hasEnvVars) {
    return supabaseResponse
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  const { data } = await supabase.auth.getUser()
  const user = data.user
  const pathname = request.nextUrl.pathname

  if (pathname.startsWith('/auth/sign-up')) {
    return redirectWithOriginalRequest(request, '/auth/login')
  }

  const allowedEmail = process.env.ALLOWED_LOGIN_EMAIL?.trim().toLowerCase()
  const userEmail = user?.email?.toLowerCase()
  const isAllowedUser =
    !allowedEmail || Boolean(userEmail && userEmail === allowedEmail)

  if (pathname === '/') {
    if (!user || !isAllowedUser) {
      return redirectWithOriginalRequest(request, '/auth/login')
    }
    return redirectWithOriginalRequest(request, '/protected')
  }

  if (user && !isAllowedUser) {
    if (pathname === '/auth/login') {
      return supabaseResponse
    }

    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.searchParams.set('error', 'unauthorized')
    return NextResponse.redirect(url)
  }

  if (!user && !pathname.startsWith('/auth')) {
    return redirectWithOriginalRequest(request, '/auth/login')
  }

  if (user && isAllowedUser && pathname.startsWith('/auth')) {
    return redirectWithOriginalRequest(request, '/protected')
  }

  return supabaseResponse
}

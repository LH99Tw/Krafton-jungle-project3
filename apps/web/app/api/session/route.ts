import { getCsrfToken, getSessionUser } from "@/app/auth/session";

export async function GET() {
  const user = await getSessionUser();
  return Response.json({
    viewer: user ? { userId: user.id, displayName: user.displayName, email: user.email, accountType: user.accountType } : null,
    csrfToken: user ? await getCsrfToken() : null,
  });
}

// Type-checking only: the bits of Deno the functions use. Supabase runs them on Deno.
declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
  const env: { get(key: string): string | undefined };
}

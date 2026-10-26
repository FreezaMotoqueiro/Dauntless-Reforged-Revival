// A deployment move approved by the operator. Match the pinned certificate and
// game as well as the old endpoint; never redirect unrelated community servers.
export const REFORGED_VPS_CERTIFICATE = "6b4e9b17f9a4e5f8ac68178127d29da157706d6f332f62037550e6294a452ca7";

export function migratedPublicServer<T extends { game: string; mode: string; host: string; port: number; fp: string | null }>(server: T): T {
  if (server.game === "reforged" && server.mode === "public"
      && server.host === "187.127.54.193" && server.port === 4443
      && server.fp === REFORGED_VPS_CERTIFICATE) {
    return { ...server, host: "179.199.154.171" };
  }
  return server;
}

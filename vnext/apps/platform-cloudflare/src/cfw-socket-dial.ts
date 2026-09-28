import { connect } from "cloudflare:sockets"
import { createCloudflareSocketDial } from "./cfw-socket-dial-core.ts"

export const cloudflareSocketDial = createCloudflareSocketDial(connect)

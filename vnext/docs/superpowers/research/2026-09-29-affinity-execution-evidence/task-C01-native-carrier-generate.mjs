import { AffinityCodec } from '/Volumes/Projects/copilot-api-gateway/vnext/packages/gateway/src/shared/affinity/carrier.ts'
import { writeFile } from 'node:fs/promises'
const codec=new AffinityCodec({ownerId:'synthetic-owner',apiKeyId:'synthetic-key',keyId:'synthetic-id',version:1,secret:new Uint8Array(32).fill(3)})
const target={provider:'custom',upstreamId:'synthetic-upstream',upstreamIncarnation:'synthetic-incarnation',credentialSubject:'synthetic-subject',credentialRevision:'synthetic-revision',model:'synthetic-model'}
const values={}
for(const type of ['reasoning','compaction'])values[type]=await codec.encode('synthetic-opaque',target,{domain:`responses/${type}/encrypted_content`})
await writeFile(new URL('./task-C01-native-carriers.json',import.meta.url),JSON.stringify(values,null,2)+'\n')
console.log('Generated two actual synthetic affinity carriers')

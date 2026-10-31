import crypto from 'crypto'
import fetch from 'node-fetch'

export default class WebhookManager {

    constructor(options = {}) {

        this.webhookUrl = options.webhookUrl || null
        this.webhookAuthToken = options.webhookAuthToken || null

        this.batchSize = options.webhookBatchSize || 10
        this.maxRetries = options.webhookMaxRetries || 5
        this.timeoutMs = options.webhookTimeoutMs || 30000

        this.buffer = []

        this.actorRunId = options.actorRunId || null
        this.actorBuildId = options.actorBuildId || null
        this.actorTaskId = options.actorTaskId || null

        this.inputFingerprint = this.sha256(
            JSON.stringify(options.input || {})
        )
    }

    sha256(value) {
        return crypto
            .createHash('sha256')
            .update(value)
            .digest('hex')
    }

    async add(record) {

        if (!record) return

        this.buffer.push(record)

        if (this.buffer.length >= this.batchSize) {
            await this.flush()
        }
    }

    async flush() {

        if (!this.webhookUrl) {
            console.log('Webhook disabled')
            this.buffer = []
            return
        }

        if (this.buffer.length === 0) return

        const batch = [...this.buffer]
        this.buffer = []

        const payload = this.buildPayload(batch)

        await this.sendWithRetry(payload)
    }

    buildPayload(records) {

        const batchId = `wh_${crypto.randomBytes(6).toString('hex')}`

        return {

            meta: {
                batch_id: batchId,
                sent_at: new Date().toISOString(),
                source_name: 'propertyroom',

                actor_run_id: this.actorRunId,
                actor_build_id: this.actorBuildId,
                actor_task_id: this.actorTaskId,

                input_fingerprint: this.inputFingerprint,

                schema: 'arb.unified_listing.v1',
                schema_version: 1,

                record_count: records.length
            },

            records: records,

            count: records.length
        }
    }

    async sendWithRetry(payload) {

        let attempt = 0

        while (attempt <= this.maxRetries) {

            try {

                const controller = new AbortController()

                const timeout = setTimeout(() => {
                    controller.abort()
                }, this.timeoutMs)

                const response = await fetch(this.webhookUrl, {

                    method: 'POST',

                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.webhookAuthToken}`
                    },

                    body: JSON.stringify(payload),

                    signal: controller.signal
                })

                clearTimeout(timeout)

                if (!response.ok) {

                    const text = await response.text()

                    throw new Error(
                        `Webhook failed ${response.status}: ${text}`
                    )
                }

                console.log(
                    `Webhook batch delivered: ${payload.meta.batch_id}`
                )

                return

            }
            catch (err) {

                attempt++

                console.error(
                    `Webhook attempt ${attempt} failed`,
                    err.message
                )

                if (attempt > this.maxRetries) {

                    console.error(
                        'Webhook permanently failed',
                        payload.meta.batch_id
                    )

                    return
                }

                await this.sleep(
                    Math.min(5000 * attempt, 20000)
                )
            }
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}
import { app } from "./app.js"
import { env } from "./config/env.js"
import { startJobs } from "./jobs/index.js"

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`)
  startJobs()
})

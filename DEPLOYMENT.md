# Render deployment

The repository-root `render.yaml` defines the backend web service. Create a Render
Blueprint from the repository and provide the prompted secret/configuration values:

- `DATABASE_URL`: the Aiven MySQL connection URI, including its required SSL mode.
- `FRONTEND_URL`: the deployed frontend's full origin, such as `https://app.example.com`.
- `CORS_ORIGIN`: the deployed frontend's origin, matching `FRONTEND_URL`.
- `JWT_SECRET`: generated automatically by Render.

Keep database credentials out of `render.yaml`, source control, and logs. If a database
password has been shared outside the deployment secret store, rotate it with the provider
and update `DATABASE_URL` in Render.

## Database migrations

The free Render service configuration does not run migrations automatically. Before the
first deployment, and whenever a deployment introduces new Prisma migrations, run
`pnpm exec prisma migrate deploy` from the `backend` directory in a trusted environment
with `DATABASE_URL` set to the Render database URI. Do not use `prisma migrate dev` against
the production database.

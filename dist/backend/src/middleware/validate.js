export const validateBody = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        res.status(400).json({ error: "Validation failed", issues: result.error.flatten().fieldErrors });
        return;
    }
    req.body = result.data;
    next();
};

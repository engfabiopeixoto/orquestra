import { z } from 'zod';

export const subscriptionUsageSchema = z.object({
  checkedAt: z.string(),
  windows: z.array(z.object({ label: z.string(), usedPercent: z.number().finite().min(0).max(100), resetsAt: z.string().nullable() })),
  credits: z.string().nullable(),
  details: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
});
export type SubscriptionUsage = z.infer<typeof subscriptionUsageSchema>;

export const usageProviderSchema = z.enum(['claude', 'codex', 'agy']);
export type UsageProvider = z.infer<typeof usageProviderSchema>;

export const providerUsageResultSchema = z.object({
  provider: usageProviderSchema,
  usage: subscriptionUsageSchema.nullable(),
  error: z.string().nullable(),
});
export type ProviderUsageResult = z.infer<typeof providerUsageResultSchema>;

export const usageParamsSchema = z.object({
  provider: usageProviderSchema.optional(),
});
export type UsageParams = z.infer<typeof usageParamsSchema>;

export const usageResultSchema = z.object({
  providers: z.array(providerUsageResultSchema),
});
export type UsageResult = z.infer<typeof usageResultSchema>;

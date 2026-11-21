import { z } from 'zod';

/** Limites usados pelo painel, pelo `orq quality` e pelo guia explicativo. */
export const QUALITY_LIMITS = {
  fileLoc: { warn: 350, bad: 600 },
  complexity: { warn: 10, bad: 20 },
  depth: { warn: 4 },
  coverageLines: { warn: 70, bad: 50 },
  mutationScore: { warn: 80, bad: 60 },
} as const;

export const QUALITY_METRICS = ['size', 'complexity', 'dependencies', 'coverage', 'mutation'] as const;
export type QualityMetricId = (typeof QUALITY_METRICS)[number];

export const qualityMetricIdSchema = z.enum(QUALITY_METRICS);
export const qualitySignalSchema = z.enum(['ok', 'warn', 'bad', 'missing']);
export type QualitySignal = z.infer<typeof qualitySignalSchema>;

export const qualityFileSchema = z.object({
  path: z.string(),
  loc: z.number(),
  test: z.boolean(),
  functions: z.number(),
  maxComplexity: z.number(),
  sumComplexity: z.number(),
  maxDepth: z.number(),
  fanIn: z.number(),
  fanOut: z.number(),
  commits90d: z.number().nullable(),
});
export type QualityFile = z.infer<typeof qualityFileSchema>;

export const qualityFunctionSchema = z.object({
  path: z.string(),
  line: z.number(),
  name: z.string(),
  complexity: z.number(),
  depth: z.number(),
  loc: z.number(),
});
export type QualityFunction = z.infer<typeof qualityFunctionSchema>;

export const qualityCycleSchema = z.object({
  files: z.array(z.string()),
  typeOnly: z.boolean(),
});
export type QualityCycle = z.infer<typeof qualityCycleSchema>;

export const coverageReportSchema = z.object({
  source: z.enum(['summary', 'final', 'lcov']),
  generatedAt: z.string(),
  stale: z.boolean(),
  lines: z.number(),
  branches: z.number().nullable(),
  functions: z.number().nullable(),
  files: z.array(z.object({ path: z.string(), lines: z.number(), uncovered: z.number() })),
});
export type CoverageReport = z.infer<typeof coverageReportSchema>;

export const mutationReportSchema = z.object({
  generatedAt: z.string(),
  score: z.number(),
  files: z.array(
    z.object({
      path: z.string(),
      score: z.number(),
      killed: z.number(),
      survived: z.number(),
      noCoverage: z.number(),
    }),
  ),
  survivors: z.array(
    z.object({
      path: z.string(),
      line: z.number(),
      mutator: z.string(),
      replacement: z.string(),
    }),
  ),
});
export type MutationReport = z.infer<typeof mutationReportSchema>;

export const qualityMetricSchema = z.object({
  id: qualityMetricIdSchema,
  signal: qualitySignalSchema,
  value: z.number().nullable(),
  delta: z.number().nullable(),
});
export type QualityMetric = z.infer<typeof qualityMetricSchema>;

export const qualityHotspotSchema = z.object({
  path: z.string(),
  score: z.number(),
  reason: z.string(),
});
export type QualityHotspot = z.infer<typeof qualityHotspotSchema>;

export const qualityChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['function-over-limit', 'file-over-limit', 'new-cycle']),
  detail: z.string(),
});
export type QualityChange = z.infer<typeof qualityChangeSchema>;

export const qualityReportSchema = z.object({
  version: z.literal(1),
  dir: z.string(),
  measuredAt: z.string(),
  durationMs: z.number(),
  language: z.enum(['js-ts', 'unsupported']),
  limits: z.object({ files: z.number(), skippedLarge: z.number(), truncated: z.boolean() }),
  metrics: z.array(qualityMetricSchema),
  files: z.array(qualityFileSchema),
  functions: z.array(qualityFunctionSchema),
  cycles: z.array(qualityCycleSchema),
  hotspots: z.array(qualityHotspotSchema),
  changed: z.array(qualityChangeSchema),
  coverage: coverageReportSchema.nullable(),
  mutation: mutationReportSchema.nullable(),
});
export type QualityReport = z.infer<typeof qualityReportSchema>;

export const qualityParamsSchema = z.object({
  changed: z.boolean().optional(),
  refresh: z.boolean().optional(),
});
export type QualityParams = z.infer<typeof qualityParamsSchema>;

/** Calcula o sinal de semáforo para uma métrica usando apenas `QUALITY_LIMITS`. */
export function signalFor(
  id: QualityMetricId,
  value: number | null,
  extra?: { typeOnlyCycles?: number; maxDepth?: number },
): QualitySignal {
  if (value === null) return 'missing';
  switch (id) {
    case 'size':
      if (value > QUALITY_LIMITS.fileLoc.bad) return 'bad';
      if (value > QUALITY_LIMITS.fileLoc.warn) return 'warn';
      return 'ok';
    case 'complexity':
      if (value > QUALITY_LIMITS.complexity.bad) return 'bad';
      if (value > QUALITY_LIMITS.complexity.warn || (extra?.maxDepth ?? 0) > QUALITY_LIMITS.depth.warn) return 'warn';
      return 'ok';
    case 'dependencies':
      if (value > 0) return 'bad';
      if ((extra?.typeOnlyCycles ?? 0) > 0) return 'warn';
      return 'ok';
    case 'coverage':
      if (value < QUALITY_LIMITS.coverageLines.bad) return 'bad';
      if (value < QUALITY_LIMITS.coverageLines.warn) return 'warn';
      return 'ok';
    case 'mutation':
      if (value < QUALITY_LIMITS.mutationScore.bad) return 'bad';
      if (value < QUALITY_LIMITS.mutationScore.warn) return 'warn';
      return 'ok';
  }
}

/**
 * Google Gemini image provider adapter.
 *
 * Handles the Google Generative Language API for image generation and editing
 * using Gemini models (Nano Banana series). Both generation and editing use
 * the same `generateContent` endpoint -- editing includes reference images
 * as inline data or file URIs in the request.
 *
 * Google API pattern:
 *
 *     POST {base_url}/models/{model_id}:generateContent?key={api_key}
 *     Request: {"contents": [{"parts": [...]}], "generationConfig": {...}}
 *     Response: {"candidates": [{"content": {"parts": [{"inlineData": {...}}]}}]}
 *
 * Models served: nano-banana-pro, nano-banana-2, nano-banana-pro-edit, nano-banana-2-edit
 */

import type { ResolvedModel } from "@worker/providers/shared.js";

/** Part types used in the Google API request body. */
interface FilePart {
  fileData: { mimeType: string; fileUri: string };
}
interface TextPart {
  text: string;
}
interface InlineDataPart {
  inlineData: { mimeType: string; data: string };
}

type Part = FilePart | TextPart | InlineDataPart;

/**
 * Build Google generateContent request body.
 *
 * @param prompt - Image description prompt
 * @param params - API-ready parameters (aspect_ratio, resolution, images, etc.)
 * @returns Request body for the Google API
 */
function buildRequestBody(
  prompt: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const parts: Part[] = [];

  // Add reference images if present (for edit models)
  const images = params.images as string[] | undefined;
  if (images) {
    for (const imgUrl of images) {
      parts.push({
        fileData: {
          mimeType: "image/png",
          fileUri: imgUrl,
        },
      });
    }
  }

  // Add text prompt
  parts.push({ text: prompt });

  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  };

  if ("aspect_ratio" in params) {
    generationConfig.aspectRatio = params.aspect_ratio;
  }
  if ("resolution" in params) {
    generationConfig.imageResolution = (params.resolution as string).toUpperCase();
  }

  const body: Record<string, unknown> = {
    contents: [{ parts }],
    generationConfig,
  };

  if (params.enable_web_search) {
    body.tools = [{ googleSearch: {} }];
  }

  return body;
}

/**
 * Extract image data from Google API response.
 *
 * The Google API returns images as base64-encoded inline data. We return
 * a data URI that can be further processed (uploaded to storage).
 *
 * @param data - Parsed JSON response
 * @returns A data URI string (`data:image/png;base64,...`), or undefined
 */
function extractImageUrl(data: Record<string, unknown>): string | undefined {
  const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates || candidates.length === 0) return undefined;

  const content = candidates[0]!.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  if (!parts) return undefined;

  for (const part of parts) {
    const inlineData = part.inlineData as Record<string, string> | undefined;
    if (inlineData && typeof inlineData.mimeType === "string" && inlineData.mimeType.startsWith("image/")) {
      return `data:${inlineData.mimeType};base64,${inlineData.data}`;
    }
  }

  return undefined;
}

/**
 * Calculate cost from Google API response usage metadata.
 *
 * @param data - Parsed JSON response containing `usageMetadata`
 * @param tokenPrice - Price per output token in USD
 * @returns Estimated cost in USD, or 0 if usage data is missing
 */
function calculateCost(data: Record<string, unknown>, tokenPrice: number): number {
  const usage = data.usageMetadata as Record<string, number> | undefined;
  const totalTokens = usage?.totalTokenCount ?? 0;
  if (totalTokens && tokenPrice) {
    return totalTokens * tokenPrice;
  }
  return 0;
}

/**
 * Generate an image asynchronously via Google Gemini API.
 *
 * @param prompt - Image description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters
 * @returns Object with `url`, `model`, and `cost`
 * @throws Error if no image is returned
 */
export async function generate(
  prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ url: string; model: string; cost: number }> {
  const body = buildRequestBody(prompt, params);

  const response = await fetch(
    `${resolved.baseUrl}/models/${resolved.modelId}:generateContent?key=${resolved.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google API HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  const url = extractImageUrl(data);
  if (!url) {
    throw new Error(
      `Google API returned no image. Response: ${JSON.stringify(data.candidates ?? [])}`,
    );
  }

  const cost = calculateCost(data, resolved.tokenPrice ?? 0);
  return { url, model: resolved.modelName, cost };
}

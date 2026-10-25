// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mapMediaLocalTimeToSource } from "@breatic/shared";

describe("mapMediaLocalTimeToSource", () => {
  it("maps output-local timestamps through the measured source and output origins", () => {
    expect(mapMediaLocalTimeToSource({
      sourceOriginUs: "10000000",
      outputTimelineOriginUs: "2000000",
      outputStartUs: "0",
      outputEndUs: "8000000",
      localTimeUs: "2500000",
    })).toBe("10500000");
  });

  it("keeps exact arithmetic across large timestamps and rejects out-of-window events", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 18n }),
      fc.bigInt({ min: 0n, max: 10n ** 12n }),
      fc.bigInt({ min: 0n, max: 10n ** 12n }),
      (sourceOriginUs, outputOriginUs, localOffsetUs) => {
        const localTimeUs = outputOriginUs + localOffsetUs;
        const mapped = mapMediaLocalTimeToSource({
          sourceOriginUs: String(sourceOriginUs),
          outputTimelineOriginUs: String(outputOriginUs),
          outputStartUs: String(outputOriginUs),
          outputEndUs: String(localTimeUs + 1n),
          localTimeUs: String(localTimeUs),
        });
        expect(BigInt(mapped)).toBe(sourceOriginUs + localOffsetUs);
      },
    ), { numRuns: 200 });

    expect(() => mapMediaLocalTimeToSource({
      sourceOriginUs: "10000000", outputTimelineOriginUs: "2000000",
      outputStartUs: "2000000", outputEndUs: "8000000", localTimeUs: "1999999",
    })).toThrow(RangeError);
    expect(() => mapMediaLocalTimeToSource({
      sourceOriginUs: "10000000", outputTimelineOriginUs: "2000000",
      outputStartUs: "2000000", outputEndUs: "8000000", localTimeUs: "8000001",
    })).toThrow(RangeError);
  });
});

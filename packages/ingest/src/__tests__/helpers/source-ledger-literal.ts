// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoSourceLedgerCompanion } from '@breatic/shared';

// Mechanical copy of the independent N01 schema fixture; no producer planner runs.
export const SOURCE_LEDGER_LITERAL: VideoSourceLedgerCompanion = {
  "schemaVersion": 1,
  "sourceFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "producerVersion": 1,
  "attempt": {
    "jobId": "accepted-source-attempt",
    "deadlineAt": 7201000
  },
  "strategy": "iso_unedited_rate_one",
  "physical": {
    "streamIndex": 1,
    "trackId": 7,
    "sourceTimeBase": {
      "numerator": "1",
      "denominator": "1000"
    },
    "frames": [
      {
        "rawDecodeOrdinal": 0,
        "ptsTicks": "0"
      },
      {
        "rawDecodeOrdinal": 1,
        "ptsTicks": "40"
      },
      {
        "rawDecodeOrdinal": 2,
        "ptsTicks": "80"
      }
    ]
  },
  "container": {
    "kind": "iso_bmff",
    "movieTimescale": "1000",
    "movieDurationTicks": "4000",
    "track": {
      "trackId": 7,
      "trackFlags": 1,
      "durationMovieTicks": "4000",
      "mediaTimescale": "1000",
      "mediaDurationTicks": "1000000000",
      "edits": null,
      "sampleTiming": {
        "decodeRuns": [
          {
            "sampleCount": 1,
            "deltaTicks": "40"
          },
          {
            "sampleCount": 1,
            "deltaTicks": "40"
          },
          {
            "sampleCount": 1,
            "deltaTicks": "40"
          }
        ],
        "cttsVersion": null,
        "compositionRuns": null,
        "compositionShift": null
      }
    }
  },
  "presentation": {
    "edits": [],
    "frames": [
      {
        "presentationOrdinal": 0,
        "editOccurrence": 0,
        "rawDecodeOrdinal": 0,
        "sourcePtsTicks": "0",
        "mappedPts": {
          "numerator": "0",
          "denominator": "1"
        },
        "displayStart": {
          "numerator": "0",
          "denominator": "1"
        },
        "displayEnd": {
          "numerator": "1",
          "denominator": "25"
        }
      },
      {
        "presentationOrdinal": 1,
        "editOccurrence": 0,
        "rawDecodeOrdinal": 1,
        "sourcePtsTicks": "40",
        "mappedPts": {
          "numerator": "1",
          "denominator": "25"
        },
        "displayStart": {
          "numerator": "1",
          "denominator": "25"
        },
        "displayEnd": {
          "numerator": "2",
          "denominator": "25"
        }
      },
      {
        "presentationOrdinal": 2,
        "editOccurrence": 0,
        "rawDecodeOrdinal": 2,
        "sourcePtsTicks": "80",
        "mappedPts": {
          "numerator": "2",
          "denominator": "25"
        },
        "displayStart": {
          "numerator": "2",
          "denominator": "25"
        },
        "displayEnd": {
          "numerator": "3",
          "denominator": "25"
        }
      }
    ]
  }
};

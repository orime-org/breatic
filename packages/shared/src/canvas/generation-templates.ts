// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Generation templates (inner#977): a fixed mode, model, params and prompt a
 * reader picks in a generate panel, and the agent may start a proposed node
 * from. The prompt is written in every interface language, since the reader
 * reads and edits it in the box; the places they fill in are the proposal
 * marks (`asset` for material, `tweak` for words).
 *
 * The mode, model, ratio and wording of the two image templates come from real
 * runs on Nano Banana Pro Ultra: a fixed ratio keeps the reference's own frame
 * and background out of the result, and the costume sheet needs the
 * photographic style and the hairstyle named or it drifts.
 */

import type { PromptSegment } from "@shared/types/canvas-proposal.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";

/** The interface languages a template prompt is written in. */
export const TEMPLATE_LOCALES = ["en", "zh-CN", "zh-TW", "ja", "ko"] as const;

/** One interface language a template prompt is written in. */
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

/** One template: a fixed way to generate, with the places the reader fills in. */
export interface GenerationTemplate {
  /** Stable id: the panel, the agent and the locale keys name it by this. */
  id: string;
  /** The generate panel that lists it. */
  nodeType: GenerationNodeType;
  /** A mode of `config/models/modes.yaml`. */
  mode: string;
  /** A model name of the catalog. */
  model: string;
  /** Only the params the template fixes. */
  params: Readonly<Record<string, unknown>>;
  /** What it makes and what it is for, in the words the agent reads. */
  agentNote: string;
  /** The prompt in each interface language. */
  prompts: Readonly<Record<TemplateLocale, readonly PromptSegment[]>>;
}

/**
 * A material mark.
 * @param label - What the reader puts there.
 * @returns The segment.
 */
function asset(label: string): PromptSegment {
  return { slot: { kind: "asset", label, note: label } };
}

/**
 * A rewrite mark.
 * @param label - What the reader writes there.
 * @returns The segment.
 */
function tweak(label: string): PromptSegment {
  return { slot: { kind: "tweak", label, note: label } };
}

/**
 * Plain words.
 * @param text - The words.
 * @returns The segment.
 */
function words(text: string): PromptSegment {
  return { text };
}

const STORYBOARD_GRID_25: GenerationTemplate = {
  id: "storyboard-grid-25",
  nodeType: "image",
  mode: "i2i",
  model: "nano-banana-pro-edit-ultra",
  params: { aspect_ratio: "1:1", resolution: "4k" },
  agentNote:
    "one 5x5 storyboard picture of a continuous story, the same characters and place in every panel; made to be turned into a video afterwards",
  prompts: {
    en: [
      words("Use "),
      asset("character or scene reference"),
      words(
        " as the reference. Create ONE image: a storyboard grid of exactly 5 rows and 5 columns, 25 equal panels in total, separated by thin white gutters, read left to right and top to bottom as one continuous sequence in time. Story: ",
      ),
      tweak("the story"),
      words(
        ". Every panel keeps the same people, outfits, location and lighting as the reference. Vary shot size and camera angle from panel to panel like a film storyboard. No text, no numbers.",
      ),
    ],
    "zh-CN": [
      words("以 "),
      asset("角色或场景参考图"),
      words(" 为参考，生成一张图：正好 5 行 5 列、共 25 格的时序分镜图，格子之间用细白线隔开，从左到右、从上到下按时间顺序连续发生。故事："),
      tweak("故事内容"),
      words("。每一格的人物、服装、场景和光线都与参考图一致。景别和机位逐格变化，像电影分镜。不出现文字和编号。"),
    ],
    "zh-TW": [
      words("以 "),
      asset("角色或場景參考圖"),
      words(" 為參考，生成一張圖：正好 5 行 5 列、共 25 格的時序分鏡圖，格子之間用細白線隔開，從左到右、從上到下按時間順序連續發生。故事："),
      tweak("故事內容"),
      words("。每一格的人物、服裝、場景和光線都與參考圖一致。景別和機位逐格變化，像電影分鏡。不出現文字和編號。"),
    ],
    ja: [
      asset("キャラクターまたはシーンの参照画像"),
      words(
        " を参照として、1枚の画像を作成してください：ちょうど5行5列、合計25コマの時系列ストーリーボード。コマの間は細い白線で区切り、左から右、上から下へ時間の順に続きます。ストーリー：",
      ),
      tweak("ストーリー"),
      words("。すべてのコマで人物、服装、場所、光を参照画像と同じに保つこと。コマごとにショットサイズとカメラアングルを変え、映画の絵コンテのようにする。文字や番号は入れない。"),
    ],
    ko: [
      asset("캐릭터 또는 장면 참고 이미지"),
      words(
        " 를 참고로 삼아 이미지 한 장을 만들어 주세요: 정확히 5행 5열, 총 25칸의 시간 순서 스토리보드. 칸 사이는 얇은 흰 선으로 나누고, 왼쪽에서 오른쪽, 위에서 아래로 시간 순서대로 이어집니다. 스토리: ",
      ),
      tweak("스토리"),
      words(". 모든 칸에서 인물, 의상, 장소, 조명을 참고 이미지와 똑같이 유지하세요. 칸마다 샷 크기와 카메라 앵글을 바꿔 영화 스토리보드처럼 만드세요. 글자와 번호는 넣지 마세요."),
    ],
  },
};

const COSTUME_SHEET: GenerationTemplate = {
  id: "costume-sheet",
  nodeType: "image",
  mode: "i2i",
  model: "nano-banana-pro-edit-ultra",
  params: { aspect_ratio: "16:9", resolution: "4k" },
  agentNote:
    "a character costume sheet: front, side and back full-body views plus close-ups of the hands or another body part, for keeping a character consistent",
  prompts: {
    en: [
      words("Use "),
      asset("character reference"),
      words(
        " as the character reference. Create ONE image: a character costume sheet on a plain light grey background. On the left, full-body front, side and back views of the same character standing side by side; on the right, smaller close-up frames of ",
      ),
      tweak("the hands or another body part"),
      words(
        ". The same photorealistic photographic style as the reference, not an illustration. The face, hairstyle, outfit, colours and body proportions match the reference in every view. Even studio lighting. No text.",
      ),
    ],
    "zh-CN": [
      words("以 "),
      asset("角色参考图"),
      words(" 为角色参考，生成一张图：浅灰纯色背景的角色定妆照。左边是同一角色的正面、侧面、背面全身三视图，并排站立；右边是"),
      tweak("手部或身体某个部位"),
      words("的局部特写小图。与参考图同样的写实摄影风格，不是插画。每一个视图里，脸、发型、服装、颜色和身材比例都与参考图一致。均匀的棚拍光线。不出现文字。"),
    ],
    "zh-TW": [
      words("以 "),
      asset("角色參考圖"),
      words(" 為角色參考，生成一張圖：淺灰純色背景的角色定妝照。左邊是同一角色的正面、側面、背面全身三視圖，並排站立；右邊是"),
      tweak("手部或身體某個部位"),
      words("的局部特寫小圖。與參考圖同樣的寫實攝影風格，不是插畫。每一個視圖裡，臉、髮型、服裝、顏色和身材比例都與參考圖一致。均勻的棚拍光線。不出現文字。"),
    ],
    ja: [
      asset("キャラクターの参照画像"),
      words(
        " をキャラクターの参照として、1枚の画像を作成してください：無地の明るいグレー背景のキャラクター衣装設定シート。左側に同じキャラクターの正面・側面・背面の全身三面図を並べて立たせ、右側に",
      ),
      tweak("手や体の一部"),
      words("のクローズアップを小さく配置。参照画像と同じ写実的な写真のスタイルで、イラストではない。どのビューでも顔、髪型、服装、色、体型を参照画像と一致させる。均一なスタジオライティング。文字は入れない。"),
    ],
    ko: [
      asset("캐릭터 참고 이미지"),
      words(
        " 를 캐릭터 참고로 삼아 이미지 한 장을 만들어 주세요: 단색 밝은 회색 배경의 캐릭터 의상 설정 시트. 왼쪽에는 같은 캐릭터의 정면, 측면, 후면 전신 삼면도를 나란히 세우고, 오른쪽에는 ",
      ),
      tweak("손 또는 신체 일부"),
      words(" 클로즈업을 작게 배치하세요. 참고 이미지와 같은 사실적인 사진 스타일이며 일러스트가 아닙니다. 모든 뷰에서 얼굴, 헤어스타일, 의상, 색상, 체형을 참고 이미지와 일치시키세요. 균일한 스튜디오 조명. 글자는 넣지 마세요."),
    ],
  },
};

/** Every template, in the order the panels list them. */
export const GENERATION_TEMPLATES: readonly GenerationTemplate[] = [STORYBOARD_GRID_25, COSTUME_SHEET];

/**
 * The templates a generate panel lists.
 * @param nodeType - The panel's node type.
 * @returns Its templates, possibly none.
 */
export function templatesFor(nodeType: GenerationNodeType): readonly GenerationTemplate[] {
  return GENERATION_TEMPLATES.filter((t) => t.nodeType === nodeType);
}

/**
 * A template by id.
 * @param id - The template id.
 * @returns The template, or undefined for an id the registry does not have.
 */
export function findTemplate(id: string): GenerationTemplate | undefined {
  return GENERATION_TEMPLATES.find((t) => t.id === id);
}

/**
 * A template's prompt in an interface language.
 * @param template - The template.
 * @param locale - The interface language; anything not written falls back to English.
 * @returns The prompt segments.
 */
export function templatePrompt(template: GenerationTemplate, locale: string): readonly PromptSegment[] {
  const known = (TEMPLATE_LOCALES as readonly string[]).includes(locale);
  return template.prompts[known ? (locale as TemplateLocale) : "en"];
}

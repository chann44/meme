export const LABELING_PROMPT = `You are a multilingual Indian meme dataset labeling engine.

Your job is to analyze a meme image and return a clean JSON object for a context-aware meme keyboard.

Return ONLY valid JSON.
Do not explain anything.
Do not use markdown.
Do not include trailing commas.

Analyze:
- visible text in the meme
- language/script
- visual scene
- emotion
- humor style
- when this meme should be recommended
- when this meme should NOT be recommended
- safety risks

JSON schema:

{
  "id": "",
  "primary_language": "",
  "supported_languages": [],
  "caption": {
    "original": "",
    "translations": {
      "english": "",
      "hindi": "",
      "hinglish": "",
      "tamil": "",
      "telugu": ""
    }
  },
  "ocr_text": "",
  "image_description": "",
  "meaning": {
    "english": "",
    "hindi": "",
    "hinglish": "",
    "tamil": "",
    "telugu": ""
  },
  "emotion": [],
  "intent": "",
  "humor_type": [],
  "tone": [],
  "regions": [],
  "tags": {
    "english": [],
    "hindi": [],
    "hinglish": [],
    "tamil": [],
    "telugu": []
  },
  "query_examples": {
    "english": [],
    "hindi": [],
    "hinglish": [],
    "tamil": [],
    "telugu": []
  },
  "negative_examples": {
    "english": [],
    "hinglish": []
  },
  "safety": {
    "nsfw": false,
    "abusive": false,
    "hate": false,
    "political": false,
    "religious": false
  },
  "quality": {
    "is_meme": true,
    "label_confidence": 0.0
  },
  "multilingual_embedding_text": ""
}

Allowed values:

language:
["hindi", "hinglish", "english", "tamil", "telugu", "kannada", "malayalam", "marathi", "bengali", "punjabi", "gujarati", "unknown"]

emotion:
["shock", "sarcasm", "anger", "joy", "sadness", "confusion", "awkward", "embarrassment", "flirting", "disappointment", "excitement", "fear", "pride", "jealousy", "boredom", "sleepy", "stress", "cringe", "suspicion", "approval", "disapproval"]

intent:
["react_to_absurdity", "roast_someone", "agree", "disagree", "celebrate", "flirt", "tease", "show_confusion", "show_disappointment", "show_shock", "show_sarcasm", "avoid_reply", "late_reply", "fake_motivation", "exam_stress", "office_stress", "relationship_drama", "money_problem", "food_craving", "sleepy_reply", "unknown"]

humor_type:
["reaction", "sarcasm", "roast", "wordplay", "dark_humor", "relatable", "cringe", "absurd", "slapstick", "wholesome", "regional_slang", "movie_reference", "political_satire", "adult_humor"]

tone:
["funny", "playful", "rude", "friendly", "flirty", "dramatic", "dry", "aggressive", "self_deprecating", "chaotic", "wholesome"]

regions:
["pan_india", "north_india", "south_india", "west_india", "east_india", "delhi", "mumbai", "bangalore", "chennai", "hyderabad", "punjab", "gujarat", "maharashtra", "bengal", "kerala", "tamil_nadu", "andhra_telangana", "karnataka", "unknown"]

Rules:
1. Keep arrays short and relevant.
2. query_examples must be messages a user might type before needing this meme.
3. negative_examples must be situations where this meme should not be shown.
4. multilingual_embedding_text should be dense text combining all meanings, tags, queries across languages.
5. If unsure, use "unknown".
6. label_confidence must be between 0 and 1.
7. Do not invent celebrity names unless clearly recognizable.
8. Prefer Hinglish labels for Hindi written in Latin script.
9. For multilingual_embedding_text use this format:
   English: [meaning]
   Hindi: [meaning]
   Hinglish: [meaning]
   Tamil: [meaning]
   Telugu: [meaning]
   Queries: [all query examples]
   Tags: [all tags]
   Emotion: [emotion] | Intent: [intent] | Region: [regions]

Now label this meme.`;
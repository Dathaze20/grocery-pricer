package com.grocerypricer.core.model

/** Merchandise categories used for category-specific pricing overrides. */
enum class Category(val displayName: String, private val keywords: List<String>) {
    CEREAL("Cereal", listOf("cereal", "froot loop", "frosted flake", "cocoa pebble", "corn flake", "cheerio", "granola", "oatmeal", "raisin bran", "apple jack")),
    LAUNDRY("Laundry", listOf("tide", "downy", "detergent", "fabric softener", "bleach pen", "gain", "arm & hammer", "laundry", "dryer sheet")),
    CLEANING("Cleaning", listOf("clorox", "lysol", "fabuloso", "pine sol", "ajax", "comet", "windex", "cleaner", "disinfect", "mr clean", "scrub")),
    PAPER_GOODS("Paper Goods", listOf("towel", "tissue", "toilet paper", "napkin", "bounty", "charmin", "scott", "plate", "cup", "foil", "wrap", "bag")),
    PET_FOOD("Pet Food", listOf("pedigree", "purina", "friskies", "dog food", "cat food", "meow mix", "alpo", "kibble")),
    CANNED_FOOD("Canned Food", listOf("goya", "bean", "canned", "soup", "tuna", "corn ", "pea ", "tomato sauce", "sardine")),
    CONDIMENTS("Condiments", listOf("mayonnaise", "mayo", "ketchup", "mustard", "relish", "hellm", "heinz", "sauce", "dressing", "vinegar")),
    COOKING_OIL("Cooking Oil", listOf("oil vegetable", "vegetable oil", "corn oil", "canola", "olive oil", "crisco", "cooking oil")),
    PERSONAL_CARE("Personal Care", listOf("shampoo", "soap", "deodorant", "toothpaste", "colgate", "dove", "razor", "lotion", "body wash")),
    BABY("Baby", listOf("pamper", "huggie", "diaper", "wipes", "similac", "enfamil", "baby")),
    SNACKS("Snacks", listOf("chip", "doritos", "lays", "cookie", "cracker", "candy", "oreo", "pretzel", "nut", "popcorn")),
    BEVERAGES("Beverages", listOf("soda", "juice", "water", "coke", "pepsi", "gatorade", "snapple", "coffee", "tea", "arizona")),
    OTHER("Other", emptyList());

    companion object {
        /**
         * Best guess at a category from a product description. Deliberately conservative:
         * anything that does not clearly match falls through to [OTHER] rather than being forced
         * into a category the pricing rules would then act on.
         */
        fun guessFrom(description: String?): Category {
            if (description.isNullOrBlank()) return OTHER
            val haystack = description.lowercase()
            return entries.firstOrNull { category ->
                category.keywords.any { haystack.contains(it) }
            } ?: OTHER
        }

        fun fromNameOrOther(name: String?): Category =
            entries.firstOrNull { it.name.equals(name, ignoreCase = true) } ?: OTHER
    }
}

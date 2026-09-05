package com.grocerypricer.app.data.repository

import com.grocerypricer.app.data.db.dao.PricingRuleDao
import com.grocerypricer.app.data.db.entity.PricingRuleEntity
import com.grocerypricer.app.data.settings.SettingsRepository
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.CategoryPricingRule
import com.grocerypricer.core.model.CostTier
import com.grocerypricer.core.model.PriceEnding
import com.grocerypricer.core.model.PricingRules
import com.grocerypricer.core.money.Money
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import java.math.BigDecimal

private const val KIND_TIER = "TIER"
private const val KIND_CATEGORY = "CATEGORY"

/**
 * Assembles the pricing configuration from the tier/category rows in the database and the
 * store-wide scalars in settings, and writes edits back the same way.
 *
 * The default deli ladder is seeded on first run so the app is useful before anything is
 * configured, but every row is the owner's to change.
 */
class PricingRulesRepository(
    private val pricingRuleDao: PricingRuleDao,
    private val settingsRepository: SettingsRepository,
) {

    val rules: Flow<PricingRules> =
        combine(pricingRuleDao.observeAll(), settingsRepository.settings) { rows, settings ->
            assemble(rows, settings.priceEndingCents, settings.highCostMarkupPercent, settings.minimumGrossMarginPercent, settings.costChangeAlertPercent)
        }

    suspend fun current(): PricingRules = rules.first()

    /** Writes the starter ladder the first time the app runs. Never overwrites existing rows. */
    suspend fun seedDefaultsIfEmpty() {
        if (pricingRuleDao.count() > 0) return
        pricingRuleDao.insertAll(PricingRules.defaultTiers().toEntities())
    }

    suspend fun replaceTiers(tiers: List<CostTier>) {
        val categories = pricingRuleDao.getAll().filter { it.kind == KIND_CATEGORY }
        pricingRuleDao.replaceAll(tiers.toEntities() + categories.map { it.copy(id = 0) })
    }

    suspend fun replaceCategoryRules(categoryRules: List<CategoryPricingRule>) {
        val tiers = pricingRuleDao.getAll().filter { it.kind == KIND_TIER }
        pricingRuleDao.replaceAll(tiers.map { it.copy(id = 0) } + categoryRules.toCategoryEntities())
    }

    suspend fun resetToDefaults() {
        pricingRuleDao.replaceAll(PricingRules.defaultTiers().toEntities())
    }

    private fun assemble(
        rows: List<PricingRuleEntity>,
        endingCents: Int,
        highCostMarkup: String,
        minimumMargin: String,
        costChangeAlert: String,
    ): PricingRules {
        val tiers = rows.filter { it.kind == KIND_TIER }
            .sortedBy { it.sortOrder }
            .mapNotNull { it.toTier() }
            .ifEmpty { PricingRules.defaultTiers() }

        val categoryRules = rows.filter { it.kind == KIND_CATEGORY }
            .mapNotNull { it.toCategoryRule() }
            .associateBy { it.category }

        return PricingRules(
            tiers = tiers,
            highCostMarkupPercent = highCostMarkup.toBigDecimalOrDefault("60"),
            defaultEnding = PriceEnding.fromCents(endingCents.coerceIn(0, 99)),
            categoryRules = categoryRules,
            minimumGrossMarginPercent = minimumMargin.toBigDecimalOrDefault("30"),
            costChangeAlertPercent = costChangeAlert.toBigDecimalOrDefault("10"),
        )
    }

    private fun PricingRuleEntity.toTier(): CostTier? {
        val min = minCostRaw ?: return null
        val max = maxCostRaw ?: return null
        val suggested = suggestedPriceRaw ?: return null
        return CostTier(
            minCost = Money.fromStorageLong(min),
            maxCost = Money.fromStorageLong(max),
            suggestedPrice = Money.fromStorageLong(suggested),
            alternatePrice = alternatePriceRaw?.let { Money.fromStorageLong(it) },
        )
    }

    private fun PricingRuleEntity.toCategoryRule(): CategoryPricingRule? {
        val categoryName = category ?: return null
        return CategoryPricingRule(
            category = Category.fromNameOrOther(categoryName),
            markupPercent = markupPercent?.toBigDecimalOrNullSafe(),
            priceEnding = priceEndingCents?.let { PriceEnding.fromCents(it) },
            tierSteps = tierSteps,
            enabled = enabled,
        )
    }

    private fun List<CostTier>.toEntities(): List<PricingRuleEntity> = mapIndexed { index, tier ->
        PricingRuleEntity(
            kind = KIND_TIER,
            minCostRaw = tier.minCost.toStorageLong(),
            maxCostRaw = tier.maxCost.toStorageLong(),
            suggestedPriceRaw = tier.suggestedPrice.toStorageLong(),
            alternatePriceRaw = tier.alternatePrice?.toStorageLong(),
            sortOrder = index,
        )
    }

    private fun List<CategoryPricingRule>.toCategoryEntities(): List<PricingRuleEntity> =
        mapIndexed { index, rule ->
            PricingRuleEntity(
                kind = KIND_CATEGORY,
                category = rule.category.name,
                markupPercent = rule.markupPercent?.toPlainString(),
                priceEndingCents = rule.priceEnding?.cents,
                tierSteps = rule.tierSteps,
                enabled = rule.enabled,
                sortOrder = index,
            )
        }
}

internal fun String?.toBigDecimalOrDefault(fallback: String): BigDecimal =
    this?.toBigDecimalOrNullSafe() ?: BigDecimal(fallback)

internal fun String.toBigDecimalOrNullSafe(): BigDecimal? =
    try {
        BigDecimal(trim())
    } catch (e: NumberFormatException) {
        null
    }

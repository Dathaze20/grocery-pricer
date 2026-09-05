package com.grocerypricer.app.data.settings

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.data.model.ThemeMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.settingsDataStore by preferencesDataStore(name = "grocery_pricer_settings")

/** Store-wide preferences, held on the device in DataStore. Nothing here leaves the phone. */
class SettingsRepository(context: Context) {

    private val dataStore = context.applicationContext.settingsDataStore

    val settings: Flow<AppSettings> = dataStore.data.map { it.toSettings() }

    suspend fun current(): AppSettings = settings.first()

    suspend fun update(transform: (AppSettings) -> AppSettings) {
        val updated = transform(current())
        dataStore.edit { prefs ->
            prefs[Keys.STORE_NAME] = updated.storeName
            prefs[Keys.DEFAULT_SUPPLIER] = updated.defaultSupplier
            prefs[Keys.PRICE_ENDING] = updated.priceEndingCents
            prefs[Keys.HIGH_COST_MARKUP] = updated.highCostMarkupPercent
            prefs[Keys.MIN_MARGIN] = updated.minimumGrossMarginPercent
            prefs[Keys.COST_CHANGE_ALERT] = updated.costChangeAlertPercent
            prefs[Keys.CAMERA_VIBRATION] = updated.cameraVibration
            prefs[Keys.CAMERA_SOUND] = updated.cameraSound
            prefs[Keys.INCLUDE_IMAGES_IN_BACKUP] = updated.includeImagesInBackup
            prefs[Keys.THEME_MODE] = updated.themeMode.name
            prefs[Keys.TUTORIAL_COMPLETED] = updated.tutorialCompleted
            prefs[Keys.CURRENT_ORDER_ID] = updated.currentOrderId
        }
    }

    suspend fun setCurrentOrder(orderId: Long) = update { it.copy(currentOrderId = orderId) }

    suspend fun markTutorialCompleted() = update { it.copy(tutorialCompleted = true) }

    private fun Preferences.toSettings(): AppSettings {
        val defaults = AppSettings()
        return AppSettings(
            storeName = this[Keys.STORE_NAME] ?: defaults.storeName,
            defaultSupplier = this[Keys.DEFAULT_SUPPLIER] ?: defaults.defaultSupplier,
            priceEndingCents = this[Keys.PRICE_ENDING] ?: defaults.priceEndingCents,
            highCostMarkupPercent = this[Keys.HIGH_COST_MARKUP] ?: defaults.highCostMarkupPercent,
            minimumGrossMarginPercent = this[Keys.MIN_MARGIN] ?: defaults.minimumGrossMarginPercent,
            costChangeAlertPercent = this[Keys.COST_CHANGE_ALERT] ?: defaults.costChangeAlertPercent,
            cameraVibration = this[Keys.CAMERA_VIBRATION] ?: defaults.cameraVibration,
            cameraSound = this[Keys.CAMERA_SOUND] ?: defaults.cameraSound,
            includeImagesInBackup = this[Keys.INCLUDE_IMAGES_IN_BACKUP] ?: defaults.includeImagesInBackup,
            themeMode = ThemeMode.fromName(this[Keys.THEME_MODE]),
            tutorialCompleted = this[Keys.TUTORIAL_COMPLETED] ?: defaults.tutorialCompleted,
            currentOrderId = this[Keys.CURRENT_ORDER_ID] ?: defaults.currentOrderId,
        )
    }

    private object Keys {
        val STORE_NAME = stringPreferencesKey("store_name")
        val DEFAULT_SUPPLIER = stringPreferencesKey("default_supplier")
        val PRICE_ENDING = intPreferencesKey("price_ending_cents")
        val HIGH_COST_MARKUP = stringPreferencesKey("high_cost_markup_percent")
        val MIN_MARGIN = stringPreferencesKey("min_margin_percent")
        val COST_CHANGE_ALERT = stringPreferencesKey("cost_change_alert_percent")
        val CAMERA_VIBRATION = booleanPreferencesKey("camera_vibration")
        val CAMERA_SOUND = booleanPreferencesKey("camera_sound")
        val INCLUDE_IMAGES_IN_BACKUP = booleanPreferencesKey("include_images_in_backup")
        val THEME_MODE = stringPreferencesKey("theme_mode")
        val TUTORIAL_COMPLETED = booleanPreferencesKey("tutorial_completed")
        val CURRENT_ORDER_ID = longPreferencesKey("current_order_id")
    }
}

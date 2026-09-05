package com.grocerypricer.app

import android.app.Application
import com.grocerypricer.app.di.AppContainer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class GroceryPricerApplication : Application() {

    lateinit var container: AppContainer
        private set

    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        // The starter cost ladder is written once, on first run, so the app is useful before
        // anything has been configured. Existing rules are never touched.
        applicationScope.launch {
            runCatching { container.pricingRulesRepository.seedDefaultsIfEmpty() }
        }
    }
}

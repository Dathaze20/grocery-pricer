package com.grocerypricer.app.ai

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The shopkeeper's AI API key, encrypted at rest by hardware where the phone has it.
 *
 * The key is theirs, it is billable, and it never belongs in the APK, in source control, in a
 * build config or in a log line. It is entered once in Settings and lives here.
 *
 * The encryption key itself is generated inside the Android Keystore and is not extractable: this
 * class can ask the Keystore to decrypt, but neither it nor anything that reads the app's data
 * directory can ever read the raw key material out. On a device with a secure element or TEE that
 * work happens off the main CPU.
 *
 * Jetpack Security's EncryptedSharedPreferences is deliberately not used - Google deprecated it,
 * and the underlying Keystore API it wrapped is a couple of dozen lines to use directly.
 */
class SecureKeyStore(context: Context) {

    private val appContext = context.applicationContext

    private val prefs by lazy {
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    /** True when a key has been saved. Does not decrypt, so it is cheap to call from the UI. */
    fun hasApiKey(): Boolean = prefs.contains(KEY_CIPHERTEXT)

    /**
     * The stored key, or null if there is none or it can no longer be decrypted.
     *
     * A key can genuinely become undecryptable - the user restored a backup onto a new phone, or
     * cleared the secure lock screen, and the Keystore entry did not come with it. That is not a
     * crash, it is a key that has to be entered again, so the unusable ciphertext is discarded.
     */
    fun apiKey(): String? {
        val stored = prefs.getString(KEY_CIPHERTEXT, null) ?: return null
        return try {
            val blob = Base64.decode(stored, Base64.NO_WRAP)
            if (blob.size <= IV_LENGTH) {
                clear()
                return null
            }
            val iv = blob.copyOfRange(0, IV_LENGTH)
            val payload = blob.copyOfRange(IV_LENGTH, blob.size)
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            }
            String(cipher.doFinal(payload), Charsets.UTF_8).takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            // Never log `e` with the ciphertext or the key alias attached.
            clear()
            null
        }
    }

    /** Saves a key, replacing any previous one. Blank input clears instead. */
    fun saveApiKey(rawKey: String): Boolean {
        val trimmed = rawKey.trim()
        if (trimmed.isEmpty()) {
            clear()
            return false
        }
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.ENCRYPT_MODE, secretKey())
            }
            val payload = cipher.doFinal(trimmed.toByteArray(Charsets.UTF_8))
            val blob = cipher.iv + payload
            prefs.edit()
                .putString(KEY_CIPHERTEXT, Base64.encodeToString(blob, Base64.NO_WRAP))
                .apply()
            true
        } catch (e: Exception) {
            false
        }
    }

    fun clear() {
        prefs.edit().remove(KEY_CIPHERTEXT).apply()
    }

    /**
     * What Settings shows once a key is saved.
     *
     * Deliberately a fixed-width mask rather than a prefix or a suffix of the real key: showing
     * even a few characters of a credential in a screenshot-able settings screen is a habit worth
     * not having, and the length of the mask says nothing about the length of the key.
     */
    fun maskedApiKey(): String? = if (hasApiKey()) MASK else null

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // No lock-screen requirement: the order pipeline runs in the background, and a
                // key that could only be read while the phone is unlocked would strand it.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "grocery_pricer_ai_provider_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val PREFS_NAME = "grocery_pricer_ai_credentials"
        const val KEY_CIPHERTEXT = "api_key_ciphertext"
        const val IV_LENGTH = 12
        const val TAG_BITS = 128
        const val MASK = "••••••••••••••"
    }
}

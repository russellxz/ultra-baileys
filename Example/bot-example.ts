import { Bot, isJidGroup, downloadMediaMessage } from '../src'
import { useMultiFileAuthState } from '../src'

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')

    const bot = new Bot({
        auth: state,
        printQRInTerminal: true,
        enableStats: true
    })

    // Comando para convertir cualquier imagen/video a sticker
    bot.command('!sticker', async (ctx) => {
        const msg = ctx.message
        
        // Verifica si el mensaje tiene multimedia o cita a un mensaje con multimedia
        const isMedia = msg.message?.imageMessage || msg.message?.videoMessage
        const isQuotedMedia = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage || 
                              msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage
                              
        if (!isMedia && !isQuotedMedia) {
            await ctx.reply({ text: 'Por favor, envía una imagen o video con el comando !sticker, o responde a uno.' })
            return
        }

        try {
            await ctx.react('⏳')
            
            // Si es un mensaje citado, lo extraemos usando la utilidad de Baileys
            const mediaMessage = isQuotedMedia ? 
                { message: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage } : msg
            
            // Descargar el buffer usando Baileys
            const buffer = await downloadMediaMessage(mediaMessage as any, 'buffer', { })
            
            // MAGIA: El MediaManager convierte el buffer a WebP automáticamente y le pone autor
            await ctx.replySticker(buffer as Buffer, { 
                packname: 'MiBot Stickers', 
                author: '@luisf' 
            })
            
            await ctx.react('✅')
        } catch (error) {
            console.error('Error al hacer sticker:', error)
            await ctx.reply({ text: 'Hubo un error convirtiendo el sticker.' })
        }
    })

    // Guardar credenciales al conectarse/actualizarse
    bot.socket?.ev.on('creds.update', saveCreds)

    await bot.start()
    console.log('🤖 Bot iniciado. ¡Prueba enviar una imagen con !sticker!')
}

startBot()

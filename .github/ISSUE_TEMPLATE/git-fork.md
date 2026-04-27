# 🔄 Sincronizar Fork com Repositório Original

## 🔧 Configuração Inicial (apenas uma vez)
```bash
git remote add upstream https://github.com/WhiskeySockets/Baileys.git
```

---

## 🚀 Atualizar Fork (use sempre que quiser sincronizar)

```bash
# 1. Buscar atualizações do original
git fetch upstream

# 2. Entrar na branch principal
git checkout master

# 3. Mesclar atualizações (aceitando tudo do upstream em conflitos)
git merge upstream/master -X theirs

# 4. Enviar para o seu fork no GitHub
git push origin master
```

---

## 🔍 Ver atualizações antes de mesclar (opcional)
```bash
git log master..upstream/master --oneline
```

---

## 🆘 Se precisar cancelar um merge no meio
```bash
git merge --abort
```

---

## 📌 Referências
- **Fork:** https://github.com/gabrieldassie/VoxuyBaileys
- **Upstream:** https://github.com/WhiskeySockets/Baileys
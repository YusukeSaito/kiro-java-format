import java.util.stream.Collectors;
import java.util.Arrays;
import java.util.regex.Pattern;
import java.util.List;
import java.util.stream.Stream;
import java.util.Locale;
import java.util.Objects;

public class Delta {
      private static final Pattern WORD = Pattern.compile("\\s+");

  public List<String> words(String text){
    return Arrays.stream(WORD.split(text.trim()))
              .filter(w -> !w.isEmpty())
        .collect(Collectors.toList());
        }

    public String upper(String text) {
            return text.toUpperCase(Locale.ROOT);
  }
}
